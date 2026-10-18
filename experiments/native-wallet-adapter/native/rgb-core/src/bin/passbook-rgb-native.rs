//! Private bounded JSON-lines IPC; one process owns journal, wallet and RGB stash.
use passbook_rgb_joint_spike::owner::{Owner, Result};
use rgb_lib::{
    AssetSchema, Assignment, BitcoinNetwork, ConsignmentExt, ContractId, FileContent, PubWitness,
    RgbTransfer,
    bitcoin::{
        OutPoint,
        hashes::{Hash, sha256},
        hex::{DisplayHex, FromHex},
        psbt::Psbt,
    },
    keys::{WitnessVersion, restore_keys},
    wallet::{
        DatabaseType, Online, OnlineOptions, Outpoint, Recipient, RgbWalletOpsOffline,
        RgbWalletOpsOnline, SinglesigKeys, Wallet, WalletData, WitnessData,
        rust_only::{
            AssetColoringInfo, ColoringInfo, ExpectedTransfer, FetchedConsignment, PsbtOpExpiry,
            validate_consignment_offchain,
        },
    },
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};
const PIN: &str = "5f655a9cd02d23996d4d79e6d5f4e6add0301197";
const MAX: usize = 24 * 1024 * 1024;
fn text<'a>(p: &'a Value, k: &str) -> Result<&'a str> {
    p[k].as_str()
        .ok_or_else(|| format!("FIELD_{k}_REQUIRED").into())
}
fn amount(p: &Value, k: &str) -> Result<u64> {
    let s = text(p, k)?;
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("DECIMAL_U64_REQUIRED".into());
    }
    Ok(s.parse()?)
}
fn integer(p: &Value, k: &str) -> Result<u32> {
    Ok(u32::try_from(p[k].as_u64().ok_or("INTEGER_REQUIRED")?)?)
}
fn random_blinding() -> Result<u64> {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn hash(bytes: &[u8]) -> String {
    sha256::Hash::hash(bytes).to_string()
}
fn opoint(p: &Value) -> Result<OutPoint> {
    Ok(OutPoint {
        txid: FromStr::from_str(text(p, "txid")?)?,
        vout: integer(p, "vout")?,
    })
}
fn psbt(p: &Value) -> Result<Psbt> {
    let tx = Psbt::from_str(text(p, "psbt")?)?;
    if tx.inputs.is_empty() || tx.inputs.len() > 64 {
        return Err("INPUT_BOUND".into());
    }
    for i in &tx.inputs {
        if let Some(s) = i.sighash_type {
            if !matches!(
                s.taproot_hash_ty()?,
                rgb_lib::bitcoin::sighash::TapSighashType::Default
                    | rgb_lib::bitcoin::sighash::TapSighashType::All
            ) {
                return Err("WHOLE_TRANSACTION_SIGHASH_REQUIRED".into());
            }
        }
    }
    Ok(tx)
}
/// Amounts leave native as exact decimal strings, including nested asset allocations.
fn exact_wire(mut value: Value) -> Value {
    fn walk(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, child) in map.iter_mut() {
                    if matches!(
                        key.as_str(),
                        "amount"
                            | "btc_amount"
                            | "settled"
                            | "spendable"
                            | "future"
                            | "issued_supply"
                            | "known_circulating_supply"
                    ) && child.is_u64()
                    {
                        *child = Value::String(child.as_u64().unwrap().to_string());
                    } else {
                        walk(child);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item);
                }
            }
            _ => (),
        }
    }
    walk(&mut value);
    value
}
struct Engine {
    owner: Owner,
    wallet: Option<Wallet>,
    online: Option<Online>,
    indexer: String,
    gate_pk: String,
    wallet_id: String,
}
impl Engine {
    fn wallet(&mut self) -> Result<&mut Wallet> {
        self.wallet.as_mut().ok_or("WALLET_NOT_OPEN".into())
    }
    fn online(&self) -> Result<Online> {
        self.online.clone().ok_or("WALLET_NOT_ONLINE".into())
    }
    fn output_history(
        &mut self,
        asset: &str,
        amount: u64,
        recipient: &str,
        blinding: u64,
        tx: &Psbt,
        vout: u32,
        consignment: &[u8],
    ) -> Result<Value> {
        let metadata = self.wallet()?.get_asset_metadata(asset.to_owned())?;
        let contract = self.wallet()?.export_asset_contract(asset.to_owned())?;
        if metadata.asset_schema != AssetSchema::Nia {
            return Err("HISTORY_NIA_REQUIRED".into());
        }
        let out = tx
            .unsigned_tx
            .output
            .get(vout as usize)
            .ok_or("HISTORY_OUTPUT_REQUIRED")?;
        let script = rgb_lib::utils::script_buf_from_recipient_id(recipient.to_owned())?
            .ok_or("HISTORY_WITNESS_RECIPIENT_REQUIRED")?;
        if out.script_pubkey != script {
            return Err("HISTORY_RECIPIENT_OUTPUT_MISMATCH".into());
        }
        let value = json!({"domain":"passbook-native-input-history/v1","native_revision":PIN,"network":"regtest","asset":{"kind":"NIA","contract_id":asset,"schema_id":contract.schema_id().to_string(),"precision":metadata.precision},"amount":amount.to_string(),"source":{"txid":tx.unsigned_tx.compute_txid().to_string(),"vout":vout,"value_sats":out.value.to_sat().to_string(),"script_pubkey":out.script_pubkey.as_bytes().to_lower_hex_string()},"recipient_id":recipient,"blinding":blinding.to_string(),"consignment_hex":consignment.to_lower_hex_string(),"colored_psbt_base64":tx.to_string()});
        let bytes = passbook_rgb_joint_spike::owner::canonical_bytes(&value)?;
        Ok(json!({"sha256":self.owner.put_artifact(&bytes)?,"byte_length":bytes.len()}))
    }
    fn dispatch(&mut self, method: &str, p: Value) -> Result<Value> {
        match method {
            "capabilities" => Ok(
                json!({"native_revision":PIN,"network":"regtest","wallet_owner":"exclusive-os-lock/v1","joint_live":false,"check_live":false}),
            ),
            "open" => {
                if self.wallet.is_some() {
                    return Err("WALLET_ALREADY_OPEN".into());
                }
                let keys = restore_keys(
                    BitcoinNetwork::Regtest,
                    text(&p, "mnemonic")?.to_owned(),
                    WitnessVersion::Taproot,
                )?;
                let identity = hash(keys.account_xpub_colored.as_bytes());
                // Identity is immutable, including across process restarts. Seed stays in caller's vault.
                self.owner.reserve(
                    &"0".repeat(64),
                    &identity,
                    json!({"wallet_id":identity,"gate_pk":text(&p,"gate_pk")?}),
                )?;
                let data = self.owner.root().join("wallet");
                fs::create_dir_all(&data)?;
                let mut w = Wallet::new(
                    WalletData {
                        data_dir: data.to_str().ok_or("PATH_ENCODING")?.to_owned(),
                        bitcoin_network: BitcoinNetwork::Regtest,
                        database_type: DatabaseType::Sqlite,
                        max_allocations_per_utxo: 5,
                        supported_schemas: vec![AssetSchema::Nia, AssetSchema::Uda],
                        reuse_addresses: false,
                    },
                    SinglesigKeys::from_keys(&keys, None),
                )?;
                self.indexer = text(&p, "indexer_url")?.to_owned();
                self.online = Some(w.go_online(OnlineOptions {
                    indexer_url: self.indexer.clone(),
                    skip_consistency_check: false,
                    vanilla_sync_lookback: 20,
                })?);
                self.gate_pk = text(&p, "gate_pk")?.to_owned();
                rgb_lib::bitcoin::key::XOnlyPublicKey::from_str(&self.gate_pk)?;
                self.wallet_id = identity.clone();
                self.wallet = Some(w);
                Ok(json!({"wallet_id":identity,"native_revision":PIN}))
            }
            "wallet_identity" => {
                if self.wallet.is_none() {
                    return Err("WALLET_NOT_OPEN".into());
                }
                Ok(json!({"wallet_id":self.wallet_id,"gate_pk":self.gate_pk}))
            }
            "import_history_artifact" => {
                let raw = self.owner.artifact(text(&p, "sha256")?)?;
                let h: Value = serde_json::from_slice(&raw)?;
                let keys = [
                    "domain",
                    "native_revision",
                    "network",
                    "asset",
                    "amount",
                    "source",
                    "recipient_id",
                    "blinding",
                    "consignment_hex",
                    "colored_psbt_base64",
                ];
                let map = h.as_object().ok_or("HISTORY_OBJECT_REQUIRED")?;
                if map.len() != keys.len()
                    || map.keys().any(|k| !keys.contains(&k.as_str()))
                    || h["domain"] != "passbook-native-input-history/v1"
                    || h["native_revision"] != PIN
                    || h["network"] != "regtest"
                    || h["asset"] != p["asset"]
                    || h["source"] != p["source"]
                    || h["amount"] != p["amount"]
                    || h["asset"]["kind"] != "NIA"
                {
                    return Err("HISTORY_BINDING_MISMATCH".into());
                }
                let tx = Psbt::from_str(text(&h, "colored_psbt_base64")?)?;
                let source = opoint(&h["source"])?;
                if tx.unsigned_tx.compute_txid() != source.txid {
                    return Err("HISTORY_WRONG_TRANSACTION".into());
                }
                let out = tx
                    .unsigned_tx
                    .output
                    .get(source.vout as usize)
                    .ok_or("HISTORY_OUTPUT_REQUIRED")?;
                if out.value.to_sat() != amount(&h["source"], "value_sats")?
                    || out.script_pubkey.as_bytes().to_lower_hex_string()
                        != text(&h["source"], "script_pubkey")?
                {
                    return Err("HISTORY_WRONG_OUTPUT".into());
                }
                let consignment = Vec::<u8>::from_hex(text(&h, "consignment_hex")?)?;
                let digest = self.owner.put_artifact(&consignment)?;
                let transfer =
                    RgbTransfer::load_file(self.owner.root().join("artifacts").join(&digest))?;
                match &transfer
                    .bundles
                    .last()
                    .ok_or("HISTORY_NO_WITNESS")?
                    .pub_witness
                {
                    PubWitness::Tx(w) if w == &tx.unsigned_tx => (),
                    _ => return Err("HISTORY_WRONG_CONSIGNMENT_WITNESS".into()),
                }
                let online = self.online()?;
                let accepted = self.wallet()?.accept_transfer_pinned(
                    online.clone(),
                    FetchedConsignment {
                        consignment: transfer,
                        txid: source.txid.to_string(),
                        vout: source.vout,
                    },
                    text(&h, "recipient_id")?.to_owned(),
                    amount(&h, "blinding")?,
                    1,
                    ExpectedTransfer {
                        asset_id: text(&h["asset"], "contract_id")?.to_owned(),
                        asset_schema: AssetSchema::Nia,
                        assignment: Assignment::Fungible(amount(&h, "amount")?),
                    },
                )?;
                if accepted.assignments != vec![Assignment::Fungible(amount(&h, "amount")?)] {
                    return Err("HISTORY_EXACT_ALLOCATION_REQUIRED".into());
                }
                self.wallet()?.save_new_asset(
                    online,
                    accepted.consignment,
                    source.txid.to_string(),
                )?;
                let metadata = self
                    .wallet()?
                    .get_asset_metadata(text(&h["asset"], "contract_id")?.to_owned())?;
                let contract = self
                    .wallet()?
                    .export_asset_contract(text(&h["asset"], "contract_id")?.to_owned())?;
                if metadata.asset_schema != AssetSchema::Nia
                    || metadata.precision != u8::try_from(integer(&h["asset"], "precision")?)?
                    || contract.schema_id().to_string() != text(&h["asset"], "schema_id")?
                {
                    return Err("HISTORY_SCHEMA_MISMATCH".into());
                }
                Ok(
                    json!({"imported":true,"source":h["source"],"asset":h["asset"],"amount":h["amount"]}),
                )
            }
            "address" => Ok(json!({"address":self.wallet()?.get_address()?})),
            "refresh" => {
                let o = self.online()?;
                self.wallet()?.refresh(o, None, vec![], false)?;
                Ok(json!({"refreshed":true}))
            }
            "balance" => {
                let b = self
                    .wallet()?
                    .get_asset_balance(text(&p, "asset_id")?.to_owned())?;
                Ok(
                    json!({"settled":b.settled.to_string(),"spendable":b.spendable.to_string(),"future":b.future.to_string()}),
                )
            }
            "asset_metadata" => {
                let asset = text(&p, "asset_id")?.to_owned();
                let metadata = self.wallet()?.get_asset_metadata(asset.clone())?;
                let contract = self.wallet()?.export_asset_contract(asset)?;
                Ok(json!({"metadata":metadata,"schema_id":contract.schema_id().to_string()}))
            }
            "assets" => Ok(serde_json::to_value(self.wallet()?.list_assets(vec![])?)?),
            "unspents" => {
                let o = self.online()?;
                Ok(serde_json::to_value(self.wallet()?.list_unspents(
                    Some(o),
                    false,
                    false,
                )?)?)
            }
            "recipient_script" => {
                let script = rgb_lib::utils::script_buf_from_recipient_id(
                    text(&p, "recipient_id")?.to_owned(),
                )?
                .ok_or("WITNESS_RECIPIENT_REQUIRED")?;
                Ok(json!({"script_pubkey":script.as_bytes().to_lower_hex_string()}))
            }
            "prepare_btc" => {
                let online = self.online()?;
                let script = rgb_lib::bitcoin::ScriptBuf::from_bytes(Vec::<u8>::from_hex(text(
                    &p,
                    "script_pubkey",
                )?)?);
                if !script.is_p2tr() {
                    return Err("P2TR_DESTINATION_REQUIRED".into());
                }
                let address = rgb_lib::bitcoin::Address::from_script(
                    &script,
                    rgb_lib::bitcoin::Network::Regtest,
                )?
                .to_string();
                let psbt = self.wallet()?.send_btc_begin(
                    online,
                    address,
                    amount(&p, "amount_sats")?,
                    u64::from(integer(&p, "fee_rate")?),
                    false,
                    true,
                    None,
                )?;
                Ok(json!({"psbt":psbt}))
            }
            "prepare_utxos" => {
                let o = self.online()?;
                let n = self.wallet()?.create_utxos_begin(
                    o,
                    false,
                    Some(u8::try_from(integer(&p, "count")?)?),
                    Some(u32::try_from(amount(&p, "size_sats")?)?),
                    u64::from(integer(&p, "fee_rate")?),
                    false,
                    false,
                )?;
                Ok(json!({"psbt":n}))
            }
            "receive" => {
                let asset = p["asset_id"].as_str().map(str::to_owned);
                let uda = p["kind"] == "uda";
                let assignment = if uda && asset.is_none() {
                    Assignment::Any
                } else if uda {
                    Assignment::NonFungible
                } else {
                    Assignment::Fungible(amount(&p, "amount")?)
                };
                let endpoints: Vec<String> =
                    serde_json::from_value(p["transport_endpoints"].clone())?;
                let confirmations = u8::try_from(integer(&p, "confirmations")?)?;
                let receive = if p["blind"].as_bool().unwrap_or(uda) {
                    self.wallet()?.blind_receive(
                        asset,
                        assignment,
                        now() + 3600,
                        endpoints,
                        confirmations,
                    )?
                } else {
                    self.wallet()?.witness_receive(
                        asset,
                        assignment,
                        now() + 3600,
                        endpoints,
                        confirmations,
                    )?
                };
                Ok(serde_json::to_value(receive)?)
            }
            "issue_nia" => Ok(serde_json::to_value(self.wallet()?.issue_asset_nia(
                text(&p, "ticker")?.to_owned(),
                text(&p, "name")?.to_owned(),
                u8::try_from(integer(&p, "precision")?)?,
                vec![amount(&p, "amount")?],
            )?)?),
            "artifact_put" => {
                let encoded = text(&p, "hex")?;
                if encoded.len() > MAX * 2 {
                    return Err("ARTIFACT_SIZE".into());
                }
                let data = Vec::<u8>::from_hex(encoded)?;
                Ok(json!({"sha256":self.owner.put_artifact(&data)?,"byte_length":data.len()}))
            }
            "artifact_get" => {
                Ok(json!({"hex":self.owner.artifact(text(&p,"sha256")?)?.to_lower_hex_string()}))
            }
            "slot_reserve" => self.owner.reserve(
                text(&p, "slot")?,
                text(&p, "intent_hash")?,
                p["intent"].clone(),
            ),
            "slot_get" => self.owner.slot(text(&p, "slot")?),
            "effect_claim" => {
                let slot = text(&p, "slot")?;
                let stage = text(&p, "stage")?;
                let prior = self.owner.effect(slot, stage)?;
                self.owner
                    .effect_intent(slot, stage, p["payload"].clone())?;
                Ok(json!({"acquired":prior["intent"].is_null(),"result":prior["result"]}))
            }
            "effect_intent" => self.owner.effect_intent(
                text(&p, "slot")?,
                text(&p, "stage")?,
                p["payload"].clone(),
            ),
            "effect_result" => {
                self.owner
                    .effect_result(text(&p, "slot")?, text(&p, "stage")?, p["result"].clone())
            }
            "effect_get" => self.owner.effect(text(&p, "slot")?, text(&p, "stage")?),
            "observe" => {
                Ok(json!({"sha256":self.owner.observe(text(&p,"slot")?,p["observation"].clone())?}))
            }
            "export_get" => Ok(json!(
                self.owner.exported(text(&p, "slot")?, text(&p, "stage")?)?
            )),
            "verify_transfer" => {
                let tx = psbt(&p)?;
                let asset = ContractId::from_str(text(&p, "asset_id")?)?;
                let metadata = self
                    .wallet()?
                    .get_asset_metadata(text(&p, "asset_id")?.to_owned())?;
                let contract = self
                    .wallet()?
                    .export_asset_contract(text(&p, "asset_id")?.to_owned())?;
                if metadata.asset_schema != AssetSchema::Nia
                    || metadata.precision != u8::try_from(integer(&p, "precision")?)?
                    || contract.schema_id().to_string() != text(&p, "schema_id")?
                {
                    return Err("NIA_SCHEMA_OR_PRECISION_MISMATCH".into());
                }
                let source = opoint(&p["source"])?;
                let amount = amount(&p, "amount")?;
                let vout = integer(&p, "vout")?;
                let indexer = self.indexer.clone();
                let a = self
                    .wallet()?
                    .validate_htlc_spend(&tx, asset, source, amount, vout, &indexer)?;
                if a.len() != 1 {
                    return Err("FULL_SINGLE_ALLOCATION_REQUIRED".into());
                }
                let known = self.wallet()?.list_assets(vec![])?;
                let assets: Vec<String> = known
                    .nia
                    .unwrap_or_default()
                    .into_iter()
                    .map(|a| a.asset_id)
                    .chain(
                        known
                            .uda
                            .unwrap_or_default()
                            .into_iter()
                            .map(|a| a.asset_id),
                    )
                    .collect();
                for id in assets {
                    let allocations = self.wallet()?.contract_assignments_for_outpoints(
                        ContractId::from_str(&id)?,
                        tx.unsigned_tx
                            .input
                            .iter()
                            .map(|i| Outpoint {
                                txid: i.previous_output.txid.to_string(),
                                vout: i.previous_output.vout,
                            })
                            .collect(),
                    )?;
                    for (point, assignments) in allocations {
                        if point.txid == source.txid.to_string()
                            && point.vout == source.vout
                            && id == text(&p, "asset_id")?
                        {
                            if assignments != vec![Assignment::Fungible(amount)] {
                                return Err("EXACT_SOURCE_ALLOCATION_REQUIRED".into());
                            }
                        } else if !assignments.is_empty() {
                            return Err("ADDITIONAL_RGB_INPUT_ALLOCATION_REFUSED".into());
                        }
                    }
                }
                Ok(json!({"valid":true}))
            }
            "verify_consignment" => {
                let tx = psbt(&p)?;
                let digest = text(&p, "sha256")?;
                let data = self.owner.artifact(digest)?;
                let path = self.owner.root().join("artifacts").join(digest);
                let transfer = RgbTransfer::load_file(&path)?;
                if transfer.contract_id().to_string() != text(&p, "asset_id")? {
                    return Err("CONSIGNMENT_WRONG_ASSET".into());
                }
                match &transfer
                    .bundles
                    .last()
                    .ok_or("CONSIGNMENT_NO_WITNESS")?
                    .pub_witness
                {
                    PubWitness::Tx(w) if w == &tx.unsigned_tx => (),
                    _ => return Err("CONSIGNMENT_WRONG_TRANSACTION".into()),
                }
                let v = validate_consignment_offchain(
                    path.to_str().ok_or("PATH_ENCODING")?,
                    &tx.unsigned_tx.compute_txid().to_string(),
                    &self.indexer,
                    BitcoinNetwork::Regtest,
                )?;
                if !v.valid {
                    return Err("CONSIGNMENT_NATIVE_VALIDATION_FAILED".into());
                }
                Ok(json!({"valid":true,"sha256":hash(&data)}))
            }
            "import_history" => {
                let o = self.online()?;
                let recipient = text(&p, "recipient_id")?.to_owned();
                let indexer_endpoint = text(&p, "proxy")?.to_owned();
                let (transfer, a) = self.wallet()?.fetch_and_accept_transfer_by_recipient_id(
                    o.clone(),
                    recipient.clone(),
                    recipient,
                    &indexer_endpoint,
                    amount(&p, "blinding")?,
                    u8::try_from(integer(&p, "confirmations")?)?,
                    ExpectedTransfer {
                        asset_id: text(&p, "asset_id")?.to_owned(),
                        asset_schema: AssetSchema::Nia,
                        assignment: Assignment::Fungible(amount(&p, "amount")?),
                    },
                )?;
                if a != vec![Assignment::Fungible(amount(&p, "amount")?)] {
                    return Err("HISTORY_ALLOCATION_MISMATCH".into());
                }
                self.wallet()?
                    .save_new_asset(o, transfer, text(&p, "txid")?.to_owned())?;
                Ok(json!({"imported":true}))
            }
            "assignments" => {
                let asset = ContractId::from_str(text(&p, "asset_id")?)?;
                let outpoints: Vec<Outpoint> = serde_json::from_value(p["outpoints"].clone())?;
                Ok(serde_json::to_value(
                    self.wallet()?
                        .contract_assignments_for_outpoints(asset, outpoints)?,
                )?)
            }
            "prepare_color" => {
                let mut tx = psbt(&p)?;
                for i in &tx.inputs {
                    if i.final_script_witness.is_some()
                        || i.tap_key_sig.is_some()
                        || !i.tap_script_sigs.is_empty()
                        || !i.partial_sigs.is_empty()
                    {
                        return Err("COLOR_AFTER_SIGNATURE_REFUSED".into());
                    }
                }
                if tx
                    .unsigned_tx
                    .output
                    .first()
                    .is_none_or(|o| !o.script_pubkey.is_op_return() || o.value.to_sat() != 0)
                {
                    return Err("OP_RETURN_ZERO_REQUIRED".into());
                }
                let asset = text(&p, "asset_id")?.to_owned();
                let source = opoint(&p["source"])?;
                let vout = integer(&p, "vout")?;
                let amount = amount(&p, "amount")?;
                let blinding = random_blinding()?;
                let result = self.wallet()?.psbt_op_prepare_with_expiry(
                    &mut tx,
                    ColoringInfo {
                        asset_info_map: HashMap::from([(
                            ContractId::from_str(&asset)?,
                            AssetColoringInfo {
                                output_map: HashMap::from([(vout, amount)]),
                                static_blinding: Some(blinding),
                            },
                        )]),
                        static_blinding: Some(blinding),
                        nonce: None,
                    },
                    vec![source],
                    u8::try_from(integer(&p, "confirmations")?)?,
                    PsbtOpExpiry::Never,
                )?;
                let path = self
                    .wallet()?
                    .get_wallet_dir()
                    .join(&result.operation_dir)
                    .join("consignments")
                    .join(hash(asset.as_bytes()))
                    .join("consignment_out");
                let data = fs::read(path)?;
                let digest = self.owner.put_artifact(&data)?;
                let history = self.output_history(
                    &asset,
                    amount,
                    text(&p, "recipient_id")?,
                    blinding,
                    &tx,
                    vout,
                    &data,
                )?;
                Ok(
                    json!({"output_history":history,"operation_id":result.operation_id,"psbt":tx.to_string(),"txid":tx.unsigned_tx.compute_txid().to_string(),"consignment":{"sha256":digest,"byte_length":data.len()}}),
                )
            }
            "prepare_send" => {
                let online = self.online()?;
                let asset = text(&p, "asset_id")?.to_owned();
                let assignment = if p["kind"] == "uda" {
                    Assignment::NonFungible
                } else {
                    Assignment::Fungible(amount(&p, "amount")?)
                };
                let blinding = p["blinding"]
                    .as_str()
                    .map(str::parse::<u64>)
                    .transpose()?
                    .unwrap_or(random_blinding()?);
                let recipient = Recipient {
                    recipient_id: text(&p, "recipient_id")?.to_owned(),
                    witness_data: if rgb_lib::utils::script_buf_from_recipient_id(
                        text(&p, "recipient_id")?.to_owned(),
                    )?
                    .is_some()
                    {
                        Some(WitnessData {
                            amount_sat: amount(&p, "output_sats")?,
                            blinding: Some(blinding),
                        })
                    } else {
                        None
                    },
                    assignment,
                    transport_endpoints: serde_json::from_value(p["transport_endpoints"].clone())?,
                };
                let begin = self.wallet()?.send_begin(
                    online,
                    HashMap::from([(asset.clone(), vec![recipient])]),
                    true,
                    u64::from(integer(&p, "fee_rate")?),
                    u8::try_from(integer(&p, "confirmations")?)?,
                    now() + 3600,
                    false,
                    None,
                )?;
                let tx = Psbt::from_str(&begin.psbt)?;
                let path = self
                    .wallet()?
                    .create_consignments_return_path(begin.psbt.clone())?;
                let data = fs::read(path)?;
                let digest = self.owner.put_artifact(&data)?;
                let output_history = if p["kind"] == "nia" {
                    let script = rgb_lib::utils::script_buf_from_recipient_id(
                        text(&p, "recipient_id")?.to_owned(),
                    )?
                    .ok_or("NIA_WITNESS_HISTORY_REQUIRED")?;
                    let vout = tx
                        .unsigned_tx
                        .output
                        .iter()
                        .position(|o| o.script_pubkey == script)
                        .ok_or("HISTORY_OUTPUT_REQUIRED")? as u32;
                    self.output_history(
                        &asset,
                        amount(&p, "amount")?,
                        text(&p, "recipient_id")?,
                        blinding,
                        &tx,
                        vout,
                        &data,
                    )?
                } else {
                    Value::Null
                };
                Ok(
                    json!({"output_history":output_history,"psbt":begin.psbt,"txid":tx.unsigned_tx.compute_txid().to_string(),"consignment":{"sha256":digest,"byte_length":data.len()}}),
                )
            }
            "complete_send" => {
                let slot = text(&p, "slot")?;
                let stage = text(&p, "stage")?;
                let exported = self
                    .owner
                    .exported(slot, stage)?
                    .ok_or("SIGNED_EXPORT_REQUIRED")?;
                let psbt =
                    String::from_utf8(self.owner.artifact(text(&exported, "signed_artifact")?)?)?;
                let online = self.online()?;
                Ok(serde_json::to_value(
                    self.wallet()?.send_end(online, psbt)?,
                )?)
            }
            "issue_receipt" => {
                // Enforce closed public media even on direct local IPC calls.
                let slot = text(&p, "slot")?;
                self.owner.slot(slot)?;
                let media = text(&p, "media_sha256")?;
                let bytes = self.owner.artifact(media)?;
                let data: Value = serde_json::from_slice(&bytes)?;
                let map = data.as_object().ok_or("RECEIPT_OBJECT")?;
                let allowed = [
                    "commitment",
                    "date",
                    "evidence_digest",
                    "kind",
                    "operator_pk",
                    "release_hash",
                    "tier",
                    "v",
                ];
                if map.len() != allowed.len()
                    || map.keys().any(|k| !allowed.contains(&k.as_str()))
                    || data["v"] != 1
                    || data["kind"] != "passbook-check-receipt"
                    || !matches!(
                        data["tier"].as_str(),
                        Some("software-evidence" | "tee-attested")
                    )
                {
                    return Err("RECEIPT_FIELDS".into());
                }
                for field in [
                    "commitment",
                    "evidence_digest",
                    "operator_pk",
                    "release_hash",
                ] {
                    let v = text(&data, field)?;
                    if v.len() != 64
                        || !v
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    {
                        return Err("RECEIPT_HASH".into());
                    }
                }
                let date = text(&data, "date")?;
                if date.len() != 10
                    || date.bytes().enumerate().any(|(i, c)| {
                        if i == 4 || i == 7 {
                            c != b'-'
                        } else {
                            !c.is_ascii_digit()
                        }
                    })
                {
                    return Err("RECEIPT_DATE".into());
                }
                if passbook_rgb_joint_spike::owner::canonical_bytes(&data)? != bytes {
                    return Err("RECEIPT_CANONICAL_BYTES".into());
                }
                self.owner.reserve(
                    &hash(format!("passbook-receipt-media/v1:{media}").as_bytes()),
                    &hash(slot.as_bytes()),
                    json!({"purchase_slot":slot,"media_sha256":media}),
                )?;
                let stage = hash(b"optional-receipt-issuance/v1");
                let previous = self.owner.effect(slot, &stage)?;
                let payload = json!({"media_sha256":media});
                self.owner.effect_intent(slot, &stage, payload)?;
                if !previous["result"].is_null() {
                    return Ok(previous["result"].clone());
                }
                let details = format!("passbook-check-receipt/v1 sha256:{media}");
                // Recover a lost issuance result by its exact unique media commitment.
                let assets = self
                    .wallet()?
                    .list_assets(vec![AssetSchema::Uda])?
                    .uda
                    .unwrap_or_default();
                let matches: Vec<_> = assets
                    .into_iter()
                    .filter(|a| a.details.as_ref() == Some(&details))
                    .collect();
                if matches.len() > 1 {
                    return Err("DUPLICATE_RECEIPT_REQUIRES_RECONCILIATION".into());
                }
                let asset = if let Some(asset) = matches.into_iter().next() {
                    asset
                } else {
                    let path = self.owner.root().join("artifacts").join(media);
                    self.wallet()?.issue_asset_uda(
                        "PBRCPT".to_owned(),
                        "Passbook check receipt".to_owned(),
                        Some(details),
                        0,
                        Some(path.to_str().ok_or("PATH_ENCODING")?.to_owned()),
                        vec![],
                    )?
                };
                let result = serde_json::to_value(asset)?;
                self.owner.effect_result(slot, &stage, result.clone())?;
                Ok(result)
            }
            "read_receipt" => {
                let asset = text(&p, "asset_id")?;
                let held = self
                    .wallet()?
                    .list_assets(vec![AssetSchema::Uda])?
                    .uda
                    .unwrap_or_default()
                    .into_iter()
                    .find(|a| a.asset_id == asset)
                    .ok_or("RECEIPT_NOT_HELD")?;
                if held.balance.settled != 1 {
                    return Err("RECEIPT_NOT_SETTLED".into());
                }
                let media = held
                    .token
                    .as_ref()
                    .and_then(|t| t.media.as_ref())
                    .ok_or("RECEIPT_MEDIA_REQUIRED")?;
                let bytes = fs::read(&media.file_path)?;
                if hash(&bytes) != media.digest {
                    return Err("RECEIPT_MEDIA_CORRUPT".into());
                }
                Ok(
                    json!({"media_sha256":media.digest,"hex":bytes.to_lower_hex_string(),"details":held.details}),
                )
            }
            "complete_utxos" => {
                let slot = text(&p, "slot")?;
                let stage = text(&p, "stage")?;
                let exported = self
                    .owner
                    .exported(slot, stage)?
                    .ok_or("SIGNED_EXPORT_REQUIRED")?;
                let psbt =
                    String::from_utf8(self.owner.artifact(text(&exported, "signed_artifact")?)?)?;
                let o = self.online()?;
                let result = self.wallet()?.create_utxos_end(o, psbt)?;
                Ok(json!({"created":result}))
            }
            "sign_export" => {
                use rgb_lib::bitcoin::key::XOnlyPublicKey;
                use rgb_lib::bitcoin::secp256k1::{Message, Secp256k1, schnorr::Signature};
                let tx = psbt(&p)?;
                let slot = text(&p, "slot")?;
                let stage = text(&p, "stage")?;
                self.owner.slot(slot)?;
                let mut permit = p["permit"].clone();
                let sig = text(&permit, "sig")?.to_owned();
                let fields = [
                    "domain",
                    "wallet_id",
                    "gate_pk",
                    "slot",
                    "stage",
                    "unsigned_psbt_sha256",
                    "proposal_hash",
                    "decoded_summary_hash",
                    "decision_id",
                    "issued_at",
                    "expires_at",
                    "sig",
                ];
                let obj = permit.as_object().ok_or("PERMIT_OBJECT_REQUIRED")?;
                if obj.len() != fields.len() || obj.keys().any(|k| !fields.contains(&k.as_str())) {
                    return Err("SIGNING_PERMIT_FIELDS".into());
                }
                for key in [
                    "wallet_id",
                    "gate_pk",
                    "slot",
                    "stage",
                    "unsigned_psbt_sha256",
                    "proposal_hash",
                    "decoded_summary_hash",
                ] {
                    let value = text(&permit, key)?;
                    if value.len() != 64
                        || !value
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    {
                        return Err("SIGNING_PERMIT_HASH".into());
                    }
                }
                let decision = text(&permit, "decision_id")?;
                if decision.is_empty() || decision.len() > 256 {
                    return Err("SIGNING_PERMIT_DECISION".into());
                }
                permit
                    .as_object_mut()
                    .ok_or("PERMIT_OBJECT_REQUIRED")?
                    .remove("sig");
                if permit["domain"] != "passbook-native-signing-permit/v1"
                    || permit["wallet_id"] != self.wallet_id
                    || permit["gate_pk"] != self.gate_pk
                    || permit["slot"] != slot
                    || permit["stage"] != stage
                    || permit["unsigned_psbt_sha256"] != hash(text(&p, "psbt")?.as_bytes())
                {
                    return Err("SIGNING_PERMIT_BINDING".into());
                }
                let digest =
                    sha256::Hash::hash(&passbook_rgb_joint_spike::owner::canonical_bytes(&permit)?);
                Secp256k1::verification_only().verify_schnorr(
                    &Signature::from_str(&sig)?,
                    &Message::from_digest(digest.to_byte_array()),
                    &XOnlyPublicKey::from_str(&self.gate_pk)?,
                )?;
                // Return exactly the retained export on an authorized replay; a fresh
                // timeout or expiry can never cause another transaction to be signed.
                if let Some(previous) = self.owner.exported(slot, stage)? {
                    if previous["authority"]["unsigned_psbt_sha256"]
                        != permit["unsigned_psbt_sha256"]
                        || previous["authority"]["decoded_summary_hash"]
                            != permit["decoded_summary_hash"]
                        || previous["authority"]["proposal_hash"] != permit["proposal_hash"]
                    {
                        return Err("EXPORTED_OPERATION_CONFLICT".into());
                    }
                    let signed = String::from_utf8(
                        self.owner.artifact(text(&previous, "signed_artifact")?)?,
                    )?;
                    return Ok(json!({"psbt":signed,"export":previous}));
                }
                let issued = permit["issued_at"].as_u64().ok_or("PERMIT_TIME")?;
                let expires = permit["expires_at"].as_u64().ok_or("PERMIT_TIME")?;
                if issued > now() || expires <= now() || expires <= issued || expires - issued > 600
                {
                    return Err("SIGNING_PERMIT_EXPIRED".into());
                }
                // Persist the gate-approved unsigned transaction before invoking a signer.
                self.owner.effect_intent(slot,stage,json!({"psbt_sha256":hash(text(&p,"psbt")?.as_bytes()),"proposal_hash":permit["proposal_hash"],"decoded_summary_hash":permit["decoded_summary_hash"]}))?;
                self.owner.artifact(text(&permit, "proposal_hash")?)?;
                self.owner
                    .artifact(text(&permit, "decoded_summary_hash")?)?;
                let signed = self.wallet()?.sign_psbt(tx.to_string(), None)?;
                let after = Psbt::from_str(&signed)?;
                if after.inputs.iter().zip(&tx.inputs).all(|(a, b)| {
                    a.final_script_witness == b.final_script_witness
                        && a.tap_key_sig == b.tap_key_sig
                        && a.tap_script_sigs == b.tap_script_sigs
                        && a.partial_sigs == b.partial_sigs
                }) {
                    return Err("NO_OWNED_SIGNATURES".into());
                }
                if Psbt::from_str(&signed)?.unsigned_tx != tx.unsigned_tx {
                    return Err("SIGNER_CHANGED_TRANSACTION".into());
                }
                let exported =
                    self.owner
                        .export(slot, stage, signed.as_bytes(), p["permit"].clone())?;
                Ok(json!({"psbt":signed,"export":exported}))
            }
            "operation_by_txid" => {
                let op = self.wallet()?.psbt_op_by_txid(text(&p, "txid")?)?;
                Ok(
                    json!({"operation_id":op.operation_id,"psbt":op.colored_psbt,"txid":op.txid,"status":format!("{:?}",op.status),"broadcast":format!("{:?}",op.broadcast)}),
                )
            }
            "mark_broadcast" => {
                self.wallet()?
                    .psbt_op_mark_broadcast(text(&p, "operation_id")?)?;
                Ok(json!({"marked":true}))
            }
            "apply" => {
                let o = self.online()?;
                self.wallet()?.psbt_op_apply(o, text(&p, "operation_id")?)?;
                Ok(json!({"applied":true}))
            }
            "reconcile" => {
                let status = self
                    .wallet()?
                    .psbt_op_reconcile(text(&p, "operation_id")?)?;
                Ok(json!({"status":format!("{status:?}")}))
            }
            "receive_consignment" => {
                let path = self
                    .owner
                    .root()
                    .join("artifacts")
                    .join(text(&p, "sha256")?);
                self.owner.artifact(text(&p, "sha256")?)?;
                let o = self.online()?;
                self.wallet()?.provide_out_of_band_consignment(
                    o,
                    path.to_str().ok_or("PATH_ENCODING")?.to_owned(),
                    vec![],
                )?;
                Ok(json!({"provided":true}))
            }
            _ => Err("UNKNOWN_METHOD".into()),
        }
    }
}
fn refusal_code(error: &(dyn std::error::Error + 'static)) -> String {
    let display = error.to_string();
    if !display.is_empty() && display.bytes().all(|c| c.is_ascii_uppercase() || c == b'_') {
        return display;
    }
    if let Some(native) = error.downcast_ref::<rgb_lib::Error>() {
        let debug = format!("{native:?}");
        let variant: String = debug
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(80)
            .collect();
        if !variant.is_empty() {
            return format!("RGB_{variant}");
        }
    }
    if error.downcast_ref::<std::io::Error>().is_some() {
        return "NATIVE_IO_ERROR".to_owned();
    }
    "NATIVE_REFUSED".to_owned()
}
fn main() -> Result<()> {
    let path = PathBuf::from(
        env::args()
            .nth(1)
            .ok_or("Usage: passbook-rgb-native PRIVATE_WALLET_DIRECTORY")?,
    );
    let mut engine = Engine {
        owner: Owner::acquire(&path)?,
        wallet: None,
        online: None,
        indexer: String::new(),
        gate_pk: String::new(),
        wallet_id: String::new(),
    };
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut stdout = io::stdout().lock();
    loop {
        let mut line = Vec::new();
        use std::io::Read;
        let n = reader
            .by_ref()
            .take((MAX + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if n > MAX {
            return Err("IPC_FRAME_TOO_LARGE".into());
        }
        let r: Value = serde_json::from_slice(&line)?;
        let id = r["id"].clone();
        let result = match text(&r, "method") {
            Ok(method) => engine.dispatch(method, r["params"].clone()),
            Err(e) => Err(e),
        };
        let response = match result {
            Ok(value) => json!({"id":id,"result":exact_wire(value)}),
            Err(e) => json!({"id":id,"error":{"code":refusal_code(e.as_ref())}}),
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
