//! Independent KaleidoSwap-fork joint-transaction capability probe, not a production loan adapter.
//! All actors use fresh native wallets. No WDK state, mobile keys, unmerged G0 contract or Lightning.
use rgb_lib::{
    AssetSchema, Assignment, BitcoinNetwork, ConsignmentExt, ContractId, FileContent, PubWitness,
    RgbTransfer, TransferStatus,
    bitcoin::{
        self, Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness,
        absolute::LockTime,
        consensus::encode::{deserialize_hex, serialize_hex},
        hashes::{Hash, sha256},
        key::{Keypair, XOnlyPublicKey},
        opcodes::all::{OP_CHECKSIG, OP_CHECKSIGVERIFY, OP_DROP},
        psbt::{Input, Psbt},
        script::Builder,
        secp256k1::{Message, Secp256k1, SecretKey},
        sighash::{Prevouts, SighashCache, TapSighashType},
        taproot::{LeafVersion, TapLeafHash, TaprootBuilder, TaprootSpendInfo},
    },
    keys::{WitnessVersion, generate_keys},
    utils::script_buf_from_recipient_id,
    wallet::{
        AssetFilter, DatabaseType, Online, OnlineOptions, Recipient, RgbWalletOpsOffline,
        RgbWalletOpsOnline, SinglesigKeys, Wallet, WalletData, WitnessData,
        rust_only::{
            AssetColoringInfo, ColoringInfo, ExpectedTransfer, PsbtOpExpiry,
            validate_consignment_offchain,
        },
    },
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    str::FromStr,
    thread::sleep,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PIN: &str = "5f655a9cd02d23996d4d79e6d5f4e6add0301197";
const NUMS: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const DEBT: u64 = 600;
const ONWARD: u64 = 66;
const C_SATS: u64 = 100_000;
const RGB_SATS: u64 = 1_000;
const BLINDING: u64 = 4242;
fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(std::io::Error::other(message).into())
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

struct Chain {
    client: reqwest::blocking::Client,
}
impl Chain {
    fn rpc(&self, miner: bool, method: &str, params: Value) -> Result<Value> {
        let url = if miner {
            "http://127.0.0.1:18723/wallet/miner"
        } else {
            "http://127.0.0.1:18723"
        };
        let response: Value = self
            .client
            .post(url)
            .basic_auth("user", Some("password"))
            .json(&json!({"jsonrpc":"2.0","id":"joint-spike","method":method,"params":params}))
            .send()?
            .json()?;
        require(
            response["error"].is_null(),
            &format!("Bitcoin {method}: {}", response["error"]),
        )?;
        Ok(response["result"].clone())
    }
    fn height(&self) -> Result<u32> {
        Ok(self
            .rpc(false, "getblockcount", json!([]))?
            .as_u64()
            .ok_or("height missing")? as u32)
    }
    fn indexed(&self) -> Result<()> {
        let target = self.height()? as u64;
        for _ in 0..120 {
            let observed = (|| -> Result<u64> {
                let mut stream = TcpStream::connect("127.0.0.1:50291")?;
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                stream.write_all(
                    b"{\"id\":1,\"method\":\"blockchain.headers.subscribe\",\"params\":[]}\n",
                )?;
                let mut line = String::new();
                BufReader::new(stream).read_line(&mut line)?;
                Ok(serde_json::from_str::<Value>(&line)?["result"]["height"]
                    .as_u64()
                    .ok_or("indexer height missing")?)
            })();
            if observed.is_ok_and(|tip| tip >= target) {
                return Ok(());
            }
            sleep(Duration::from_millis(250));
        }
        Err("isolated electrs did not catch up".into())
    }
    fn mine(&self, blocks: u32) -> Result<()> {
        let address = self.rpc(true, "getnewaddress", json!([]))?;
        self.rpc(true, "generatetoaddress", json!([blocks, address]))?;
        self.indexed()
    }
    fn raw(&self, txid: &str) -> Result<Transaction> {
        let raw = self.rpc(false, "getrawtransaction", json!([txid]))?;
        Ok(deserialize_hex(raw.as_str().ok_or("raw tx missing")?)?)
    }
    fn verdict(&self, tx: &Transaction) -> Result<Value> {
        Ok(self.rpc(false, "testmempoolaccept", json!([[serialize_hex(tx)]]))?[0].clone())
    }
    fn broadcast(&self, tx: &Transaction) -> Result<()> {
        self.rpc(false, "sendrawtransaction", json!([serialize_hex(tx)]))?;
        self.mine(1)
    }
    fn unspent(&self, outpoint: OutPoint) -> Result<bool> {
        Ok(!self
            .rpc(
                false,
                "gettxout",
                json!([outpoint.txid.to_string(), outpoint.vout, true]),
            )?
            .is_null())
    }
}
const ELECTRUM: &str = "127.0.0.1:50291";
const PROXY: &str = "rpc://127.0.0.1:3390/json-rpc";
struct Party {
    wallet: Wallet,
    online: Online,
}
impl Party {
    fn create(path: &Path, chain: &Chain) -> Result<Self> {
        fs::create_dir(path)?;
        let keys = generate_keys(BitcoinNetwork::Regtest, WitnessVersion::Taproot);
        let mut wallet = Wallet::new(
            WalletData {
                data_dir: path.to_str().ok_or("path encoding")?.to_owned(),
                bitcoin_network: BitcoinNetwork::Regtest,
                database_type: DatabaseType::Sqlite,
                max_allocations_per_utxo: 5,
                supported_schemas: vec![AssetSchema::Nia],
                reuse_addresses: false,
            },
            SinglesigKeys::from_keys(&keys, None),
        )?;
        let online = wallet.go_online(OnlineOptions {
            indexer_url: ELECTRUM.to_owned(),
            skip_consistency_check: false,
            vanilla_sync_lookback: 20,
        })?;
        let address = wallet.get_address()?;
        chain.rpc(true, "sendtoaddress", json!([address, 0.1]))?;
        chain.mine(1)?;
        wallet.create_utxos(online.clone(), false, Some(5), Some(5000), 2, false)?;
        chain.mine(1)?;
        Ok(Self { wallet, online })
    }
    fn refresh(&mut self) -> Result<()> {
        self.wallet
            .refresh(self.online.clone(), None, vec![], false)?;
        Ok(())
    }
    fn balance(&self, asset: &str) -> Result<Value> {
        let value = self.wallet.get_asset_balance(asset.to_owned())?;
        Ok(json!({"settled":value.settled,"spendable":value.spendable,"future":value.future}))
    }
    fn settled(&mut self, asset: &str, amount: u64) -> Result<Value> {
        for _ in 0..40 {
            self.refresh()?;
            let value = self.balance(asset)?;
            if value["settled"] == amount && value["spendable"] == amount {
                return Ok(value);
            }
            sleep(Duration::from_millis(250));
        }
        Err(format!("balance mismatch for {asset}: {}", self.balance(asset)?).into())
    }
    fn receive(&mut self, asset: Option<String>, amount: u64, proxy: bool) -> Result<String> {
        Ok(self
            .wallet
            .witness_receive(
                asset,
                Assignment::Fungible(amount),
                now() + 3600,
                if proxy {
                    vec![PROXY.to_owned()]
                } else {
                    vec![]
                },
                1,
            )?
            .recipient_id)
    }
}
fn recipient_script(recipient: &str) -> Result<ScriptBuf> {
    script_buf_from_recipient_id(recipient.to_owned())?
        .ok_or("expected ordinary witness recipient".into())
}
fn address(script: &ScriptBuf) -> Result<String> {
    Ok(bitcoin::Address::from_script(script, bitcoin::Network::Regtest)?.to_string())
}
fn send_asset(
    sender: &mut Party,
    receiver: &mut Party,
    chain: &Chain,
    asset: &str,
    amount: u64,
    blinding: Option<u64>,
) -> Result<(String, OutPoint, TxOut)> {
    let recipient = receiver.receive(None, amount, true)?;
    let script = recipient_script(&recipient)?;
    let sent = sender.wallet.send(
        sender.online.clone(),
        HashMap::from([(
            asset.to_owned(),
            vec![Recipient {
                recipient_id: recipient.clone(),
                witness_data: Some(WitnessData {
                    amount_sat: RGB_SATS,
                    blinding,
                }),
                assignment: Assignment::Fungible(amount),
                transport_endpoints: vec![PROXY.to_owned()],
            }],
        )]),
        true,
        2,
        1,
        now() + 3600,
        None,
    )?;
    chain.mine(1)?;
    receiver.settled(asset, amount)?;
    sender.refresh()?;
    let tx = chain.raw(&sent.txid)?;
    let vout = tx
        .output
        .iter()
        .position(|out| out.script_pubkey == script)
        .ok_or("asset output missing")?;
    Ok((
        recipient,
        OutPoint {
            txid: tx.compute_txid(),
            vout: vout as u32,
        },
        tx.output[vout].clone(),
    ))
}
struct AssetInput {
    asset: String,
    outpoint: OutPoint,
    txout: TxOut,
}
fn principal(
    issuer: &mut Party,
    lender: &mut Party,
    borrower: &mut Party,
    chain: &Chain,
    ticker: &str,
) -> Result<AssetInput> {
    let asset = issuer
        .wallet
        .issue_asset_nia(
            ticker.to_owned(),
            "Joint test asset (no value)".to_owned(),
            0,
            vec![DEBT],
        )?
        .asset_id;
    let (recipient, outpoint, txout) =
        send_asset(issuer, lender, chain, &asset, DEBT, Some(BLINDING))?;
    // Import and chain-pin the lender's ordinary keypath-controlled input history into a
    // separately generated borrower wallet BEFORE the proposed origination exists or is signed.
    let (consignment, assignments) = borrower.wallet.fetch_and_accept_transfer_by_recipient_id(
        borrower.online.clone(),
        recipient.clone(),
        recipient,
        PROXY,
        BLINDING,
        1,
        ExpectedTransfer {
            asset_id: asset.clone(),
            asset_schema: AssetSchema::Nia,
            assignment: Assignment::Fungible(DEBT),
        },
    )?;
    require(
        assignments == vec![Assignment::Fungible(DEBT)],
        "principal history amount mismatch",
    )?;
    borrower.wallet.save_new_asset(
        borrower.online.clone(),
        consignment,
        outpoint.txid.to_string(),
    )?;
    Ok(AssetInput {
        asset,
        outpoint,
        txout,
    })
}

/// A demonstration collateral policy. Default and repayment share the same 2-of-2 leaf;
/// the default's fixed nLockTime is protected by both pre-signatures. No secret or HTLC.
struct Collateral {
    borrower: Keypair,
    lender: Keypair,
    leaf: ScriptBuf,
    tree: TaprootSpendInfo,
    context: [u8; 32],
}
impl Collateral {
    fn new(context: [u8; 32]) -> Result<Self> {
        let secp = Secp256k1::new();
        let random_key = || -> Result<Keypair> {
            let mut bytes = [0; 32];
            fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
            Ok(Keypair::from_secret_key(
                &secp,
                &SecretKey::from_slice(&bytes)?,
            ))
        };
        let borrower = random_key()?;
        let lender = random_key()?;
        let leaf = Builder::new()
            .push_slice(context)
            .push_opcode(OP_DROP)
            .push_x_only_key(&borrower.x_only_public_key().0)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_x_only_key(&lender.x_only_public_key().0)
            .push_opcode(OP_CHECKSIG)
            .into_script();
        let tree = TaprootBuilder::new()
            .add_leaf(0, leaf.clone())?
            .finalize(&secp, XOnlyPublicKey::from_str(NUMS)?)
            .map_err(|_| "invalid collateral tree")?;
        Ok(Self {
            borrower,
            lender,
            leaf,
            tree,
            context,
        })
    }
    fn script(&self) -> ScriptBuf {
        ScriptBuf::new_p2tr_tweaked(self.tree.output_key())
    }
    fn signature(
        &self,
        tx: &Transaction,
        prevouts: &[TxOut],
        index: usize,
        lender: bool,
    ) -> Result<Vec<u8>> {
        let hash = SighashCache::new(tx).taproot_script_spend_signature_hash(
            index,
            &Prevouts::All(prevouts),
            TapLeafHash::from_script(&self.leaf, LeafVersion::TapScript),
            TapSighashType::Default,
        )?;
        Ok(Secp256k1::new()
            .sign_schnorr_no_aux_rand(
                &Message::from_digest(hash.to_byte_array()),
                if lender { &self.lender } else { &self.borrower },
            )
            .as_ref()
            .to_vec())
    }
    fn witness(&self, borrower_sig: Vec<u8>, lender_sig: Vec<u8>) -> Result<Witness> {
        let control = self
            .tree
            .control_block(&(self.leaf.clone(), LeafVersion::TapScript))
            .ok_or("missing control block")?;
        Ok(Witness::from_slice(&[
            lender_sig,
            borrower_sig,
            self.leaf.as_bytes().to_vec(),
            control.serialize(),
        ]))
    }
    fn verify_witness(&self, tx: &Transaction, prevouts: &[TxOut], index: usize) -> Result<()> {
        let items = tx.input[index].witness.to_vec();
        require(items.len() == 4, "unexpected collateral witness")?;
        require(items[2] == self.leaf.as_bytes(), "wrong collateral leaf")?;
        let expected_control = self
            .tree
            .control_block(&(self.leaf.clone(), LeafVersion::TapScript))
            .ok_or("missing collateral control block")?
            .serialize();
        require(
            items[3] == expected_control,
            "wrong collateral control block",
        )?;
        let hash = SighashCache::new(tx).taproot_script_spend_signature_hash(
            index,
            &Prevouts::All(prevouts),
            TapLeafHash::from_script(&self.leaf, LeafVersion::TapScript),
            TapSighashType::Default,
        )?;
        let message = Message::from_digest(hash.to_byte_array());
        for (signature, key) in [(&items[0], &self.lender), (&items[1], &self.borrower)] {
            require(
                signature.len() == 64,
                "default requires whole-transaction DEFAULT signature",
            )?;
            let signature = bitcoin::secp256k1::schnorr::Signature::from_slice(signature)?;
            Secp256k1::new().verify_schnorr(&signature, &message, &key.x_only_public_key().0)?;
        }
        Ok(())
    }
    fn default(
        &self,
        outpoint: OutPoint,
        txout: &TxOut,
        destination: ScriptBuf,
        height: u32,
    ) -> Result<Transaction> {
        let mut tx = Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: LockTime::from_height(height)?,
            input: vec![txin(outpoint)],
            output: vec![TxOut {
                value: Amount::from_sat(C_SATS - 1000),
                script_pubkey: destination,
            }],
        };
        // Both signatures are generated while C does not yet exist on-chain.
        let b = self.signature(&tx, std::slice::from_ref(txout), 0, false)?;
        let l = self.signature(&tx, std::slice::from_ref(txout), 0, true)?;
        tx.input[0].witness = self.witness(b, l)?;
        Ok(tx)
    }
}
fn txin(outpoint: OutPoint) -> TxIn {
    TxIn {
        previous_output: outpoint,
        script_sig: ScriptBuf::new(),
        sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
        witness: Witness::new(),
    }
}
fn append_input(psbt: &mut Psbt, outpoint: OutPoint, txout: TxOut) -> usize {
    let index = psbt.inputs.len();
    psbt.unsigned_tx.input.push(txin(outpoint));
    psbt.inputs.push(Input {
        witness_utxo: Some(txout),
        ..Default::default()
    });
    index
}
fn output_index(psbt: &Psbt, script: &ScriptBuf) -> Result<u32> {
    Ok(psbt
        .unsigned_tx
        .output
        .iter()
        .position(|out| &out.script_pubkey == script)
        .ok_or("required output missing")? as u32)
}
fn prevouts(psbt: &Psbt) -> Result<Vec<TxOut>> {
    psbt.inputs
        .iter()
        .map(|input| {
            input
                .witness_utxo
                .clone()
                .ok_or("missing witness_utxo".into())
        })
        .collect()
}
fn sighashes(psbt: &Psbt) -> Result<()> {
    for input in &psbt.inputs {
        if let Some(kind) = input.sighash_type {
            let kind = kind.taproot_hash_ty()?;
            require(
                matches!(kind, TapSighashType::Default | TapSighashType::All),
                "forbidden weak sighash",
            )?;
        }
    }
    Ok(())
}
fn unsigned(psbt: &Psbt) -> bool {
    psbt.inputs.iter().all(|input| {
        input.final_script_witness.is_none()
            && input.final_script_sig.is_none()
            && input.partial_sigs.is_empty()
            && input.tap_key_sig.is_none()
            && input.tap_script_sigs.is_empty()
    })
}
fn rgb_validate(
    party: &Party,
    psbt: &Psbt,
    asset: &AssetInput,
    vout: u32,
    amount: u64,
) -> Result<()> {
    let allocation = party.wallet.validate_htlc_spend(
        psbt,
        ContractId::from_str(&asset.asset)?,
        asset.outpoint,
        amount,
        vout,
        ELECTRUM,
    )?;
    require(allocation.len() == 1, "unexpected allocation set")
}
fn bitcoin_policy(chain: &Chain, psbt: &Psbt) -> Result<u64> {
    sighashes(psbt)?;
    require(
        psbt.unsigned_tx.input.len() == psbt.inputs.len(),
        "PSBT input length mismatch",
    )?;
    require(
        psbt.unsigned_tx.output[0].script_pubkey.is_op_return(),
        "RGB OP_RETURN not output zero",
    )?;
    let mut unique = HashSet::new();
    let mut input_sum = 0;
    for (txin, input) in psbt.unsigned_tx.input.iter().zip(&psbt.inputs) {
        require(unique.insert(txin.previous_output), "duplicate input")?;
        require(
            txin.script_sig.is_empty(),
            "non-Segwit scriptSig would destabilize future txid",
        )?;
        let actual = chain.raw(&txin.previous_output.txid.to_string())?;
        let prevout = actual
            .output
            .get(txin.previous_output.vout as usize)
            .ok_or("vout missing")?;
        require(
            prevout.script_pubkey.is_p2tr(),
            "probe requires native Taproot inputs",
        )?;
        require(
            input.witness_utxo.as_ref() == Some(prevout),
            "forged input value or script",
        )?;
        require(chain.unspent(txin.previous_output)?, "input already spent")?;
        input_sum += prevout.value.to_sat();
    }
    let output_sum: u64 = psbt
        .unsigned_tx
        .output
        .iter()
        .map(|out| out.value.to_sat())
        .sum();
    let fee = input_sum
        .checked_sub(output_sum)
        .ok_or("outputs exceed inputs")?;
    require((500..=5000).contains(&fee), "unexpected fee")?;
    Ok(fee)
}
struct Prepared {
    psbt: Psbt,
    operation: String,
    consignment: PathBuf,
    recipient: String,
    rgb_vout: u32,
    fee: u64,
}
fn color(
    owner: &Party,
    chain: &Chain,
    mut psbt: Psbt,
    asset: &AssetInput,
    recipient: String,
) -> Result<Prepared> {
    require(unsigned(&psbt), "input signed before RGB coloring")?;
    psbt.unsigned_tx.output.insert(
        0,
        TxOut {
            value: Amount::ZERO,
            script_pubkey: ScriptBuf::new_op_return([]),
        },
    );
    psbt.outputs.insert(0, Default::default());
    let rgb_vout = output_index(&psbt, &recipient_script(&recipient)?)?;
    let prepared = owner.wallet.psbt_op_prepare_with_expiry(
        &mut psbt,
        ColoringInfo {
            asset_info_map: HashMap::from([(
                ContractId::from_str(&asset.asset)?,
                AssetColoringInfo {
                    output_map: HashMap::from([(rgb_vout, DEBT)]),
                    static_blinding: Some(888),
                },
            )]),
            static_blinding: Some(888),
            nonce: None,
        },
        vec![asset.outpoint],
        1,
        PsbtOpExpiry::Never,
    )?;
    let fee = bitcoin_policy(chain, &psbt)?;
    let consignment = owner
        .wallet
        .get_wallet_dir()
        .join(&prepared.operation_dir)
        .join("consignments")
        .join(sha256::Hash::hash(asset.asset.as_bytes()).to_string())
        .join("consignment_out");
    require(consignment.is_file(), "prepared consignment file missing")?;
    Ok(Prepared {
        psbt,
        operation: prepared.operation_id,
        consignment,
        recipient,
        rgb_vout,
        fee,
    })
}
struct HeldProof {
    consignment: PathBuf,
    consignment_hash: String,
    psbt_hash: String,
}
fn durable_copy(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::File::open(path.parent().ok_or("proof parent missing")?)?.sync_all()?;
    Ok(())
}
/// Receive complete immutable proof material BEFORE releasing a funding or repayment signature.
/// This fixture uses a local file copy as transport, but the destination is the receiver's own
/// store; settlement never reads the sender's copy after signatures have been released.
fn hold_proof(receiver: &Party, prepared: &Prepared, asset: &AssetInput) -> Result<HeldProof> {
    require(
        unsigned(&prepared.psbt),
        "proof possession must precede every signature",
    )?;
    let txid = prepared.psbt.unsigned_tx.compute_txid().to_string();
    let directory = receiver
        .wallet
        .get_wallet_dir()
        .join("joint-received-proofs");
    fs::create_dir_all(&directory)?;
    let consignment = directory.join(format!("{txid}.consignment"));
    let psbt = directory.join(format!("{txid}.psbt"));
    let bytes = fs::read(&prepared.consignment)?;
    let psbt_bytes = prepared.psbt.to_string().into_bytes();
    durable_copy(&consignment, &bytes)?;
    durable_copy(&psbt, &psbt_bytes)?;
    let held = RgbTransfer::load_file(&consignment)?;
    require(
        held.contract_id().to_string() == asset.asset,
        "held proof has wrong contract",
    )?;
    match &held
        .bundles
        .last()
        .ok_or("held proof has no witness")?
        .pub_witness
    {
        PubWitness::Tx(witness) => require(
            witness == &prepared.psbt.unsigned_tx,
            "held proof has different unsigned transaction",
        )?,
        _ => return Err("held proof does not contain the complete unsigned witness".into()),
    }
    let validation = validate_consignment_offchain(
        consignment.to_str().ok_or("proof path encoding")?,
        &txid,
        ELECTRUM,
        BitcoinNetwork::Regtest,
    )?;
    require(
        validation.valid,
        &format!("held consignment invalid: {:?}", validation.details),
    )?;
    rgb_validate(receiver, &prepared.psbt, asset, prepared.rgb_vout, DEBT)?;
    require(
        fs::read(&consignment)? == bytes && fs::read(&psbt)? == psbt_bytes,
        "proof copy changed",
    )?;
    Ok(HeldProof {
        consignment,
        consignment_hash: sha256::Hash::hash(&bytes).to_string(),
        psbt_hash: sha256::Hash::hash(&psbt_bytes).to_string(),
    })
}
fn native_sign(party: &Party, psbt: &Psbt) -> Result<Psbt> {
    sighashes(psbt)?;
    let result = Psbt::from_str(&party.wallet.sign_psbt(psbt.to_string(), None)?)?;
    require(
        result.unsigned_tx == psbt.unsigned_tx,
        "native signer mutated transaction",
    )?;
    Ok(result)
}
fn extract(psbt: Psbt) -> Result<Transaction> {
    require(
        psbt.inputs
            .iter()
            .all(|input| input.final_script_witness.is_some()),
        "unfinished input",
    )?;
    Ok(psbt.extract_tx()?)
}
fn confirm(
    owner: &mut Party,
    receiver: &mut Party,
    chain: &Chain,
    asset: &AssetInput,
    prepared: &Prepared,
    proof: &HeldProof,
    tx: &Transaction,
) -> Result<Value> {
    require(
        tx.compute_txid() == prepared.psbt.unsigned_tx.compute_txid(),
        "witness signing changed txid",
    )?;
    owner.wallet.psbt_op_mark_broadcast(&prepared.operation)?;
    chain.broadcast(tx)?;
    owner
        .wallet
        .psbt_op_apply(owner.online.clone(), &prepared.operation)?;
    // The sender owns the journal. Settlement uses the receiver's copy held before signatures.
    require(
        sha256::Hash::hash(&fs::read(&proof.consignment)?).to_string() == proof.consignment_hash,
        "receiver-held proof changed after signing",
    )?;
    receiver.wallet.provide_out_of_band_consignment(
        receiver.online.clone(),
        proof
            .consignment
            .to_str()
            .ok_or("path encoding")?
            .to_owned(),
        vec![],
    )?;
    let balance = receiver.settled(&asset.asset, DEBT)?;
    owner.refresh()?;
    let transfers = receiver.wallet.list_transfers(
        AssetFilter::Id(asset.asset.clone()),
        Some(tx.compute_txid().to_string()),
    )?;
    let transfer = transfers
        .iter()
        .find(|transfer| transfer.recipient_id.as_deref() == Some(prepared.recipient.as_str()))
        .ok_or("incoming transfer missing")?;
    require(
        transfer.status == TransferStatus::Settled,
        "receipt did not settle",
    )?;
    Ok(
        json!({"txid":tx.compute_txid().to_string(),"operation_id":prepared.operation,"rgb_vout":prepared.rgb_vout,
        "status":"Settled","balance":balance,"fee_sats":prepared.fee,
        "receiver_held_proof_before_signatures":true,"receiver_consignment_sha256":proof.consignment_hash,
        "receiver_unsigned_psbt_sha256":proof.psbt_hash}),
    )
}
struct Originated {
    asset: AssetInput,
    collateral: Collateral,
    c_outpoint: OutPoint,
    c_txout: TxOut,
    default: Transaction,
    default_height: u32,
    origin: Value,
}
fn originate(
    issuer: &mut Party,
    lender: &mut Party,
    borrower: &mut Party,
    chain: &Chain,
    ticker: &str,
) -> Result<Originated> {
    let principal = principal(issuer, lender, borrower, chain, ticker)?;
    let collateral =
        Collateral::new(sha256::Hash::hash(principal.asset.as_bytes()).to_byte_array())?;
    let recipient = borrower.receive(Some(principal.asset.clone()), DEBT, false)?;
    let receiver_script = recipient_script(&recipient)?;
    let mut psbt = Psbt::from_str(&borrower.wallet.send_btc_many_begin(
        borrower.online.clone(),
        vec![
            (address(&collateral.script())?, C_SATS),
            (address(&receiver_script)?, RGB_SATS),
        ],
        2,
        false,
        true,
        None,
        vec![],
    )?)?;
    append_input(&mut psbt, principal.outpoint, principal.txout.clone());
    let prepared = color(lender, chain, psbt, &principal, recipient)?;
    require(
        unsigned(&prepared.psbt),
        "origination signed before independent validation",
    )?;
    // These are different native wallet instances with separately generated keys and histories.
    rgb_validate(
        borrower,
        &prepared.psbt,
        &principal,
        prepared.rgb_vout,
        DEBT,
    )?;
    let c_vout = output_index(&prepared.psbt, &collateral.script())?;
    let c_txout = prepared.psbt.unsigned_tx.output[c_vout as usize].clone();
    require(c_txout.value.to_sat() == C_SATS, "collateral value changed")?;
    require(
        prepared.psbt.unsigned_tx.output[prepared.rgb_vout as usize]
            .value
            .to_sat()
            == RGB_SATS,
        "principal carrier value changed",
    )?;
    let c_outpoint = OutPoint {
        txid: prepared.psbt.unsigned_tx.compute_txid(),
        vout: c_vout,
    };
    require(
        !chain.unspent(c_outpoint)?,
        "collateral exists before origination",
    )?;
    let default_height = chain.height()? + 12;
    let lender_return = bitcoin::Address::from_str(&lender.wallet.get_address()?)?
        .require_network(bitcoin::Network::Regtest)?
        .script_pubkey();
    let proof = hold_proof(borrower, &prepared, &principal)?;
    let default = collateral.default(c_outpoint, &c_txout, lender_return, default_height)?;
    // L verifies both default signatures against the exact future prevout before releasing
    // its principal-funding signature. This verification needs no on-chain C output yet.
    collateral.verify_witness(&default, std::slice::from_ref(&c_txout), 0)?;
    require(
        unsigned(&prepared.psbt),
        "funding signatures exported before default pre-sign",
    )?;
    // Witness-only native signing preserves the already committed future C outpoint.
    let lender_signed = native_sign(lender, &prepared.psbt)?;
    let fully_signed = native_sign(borrower, &lender_signed)?;
    let tx = extract(fully_signed)?;
    require(
        chain.verdict(&tx)?["allowed"] == true,
        "joint origination rejected",
    )?;
    let mut origin = confirm(lender, borrower, chain, &principal, &prepared, &proof, &tx)?;
    require(
        chain.unspent(c_outpoint)?,
        "joint origination did not create collateral",
    )?;
    origin["c_outpoint"] = json!(c_outpoint.to_string());
    origin["default_presigned_before_funding_signatures"] = json!(true);
    origin["default_signatures_verified_before_funding_signatures"] = json!(true);
    origin["independent_unsigned_principal_validation"] = json!(true);
    let outpoint = OutPoint {
        txid: tx.compute_txid(),
        vout: prepared.rgb_vout,
    };
    let txout = tx.output[prepared.rgb_vout as usize].clone();
    // The lender owns the prior outgoing operation: apply imported the full transition to B.
    // Verify it can validate B's resulting allocation later, without sharing B's wallet state.
    Ok(Originated {
        asset: AssetInput {
            asset: principal.asset,
            outpoint,
            txout,
        },
        collateral,
        c_outpoint,
        c_txout,
        default,
        default_height,
        origin,
    })
}
struct Repayment {
    prepared: Prepared,
    proof: HeldProof,
    transaction: Transaction,
    c_index: usize,
    return_vout: u32,
    negatives: Value,
}
fn prepare_repayment(
    borrower: &mut Party,
    lender: &mut Party,
    chain: &Chain,
    loan: &Originated,
) -> Result<Repayment> {
    let recipient = lender.receive(Some(loan.asset.asset.clone()), DEBT, false)?;
    let receiver_script = recipient_script(&recipient)?;
    let mut psbt = Psbt::from_str(&borrower.wallet.send_btc_begin(
        borrower.online.clone(),
        address(&receiver_script)?,
        RGB_SATS,
        2,
        false,
        true,
        None,
    )?)?;
    append_input(&mut psbt, loan.asset.outpoint, loan.asset.txout.clone());
    let c_index = append_input(&mut psbt, loan.c_outpoint, loan.c_txout.clone());
    let return_script = bitcoin::Address::from_str(&borrower.wallet.get_address()?)?
        .require_network(bitcoin::Network::Regtest)?
        .script_pubkey();
    psbt.unsigned_tx.output.push(TxOut {
        value: Amount::from_sat(C_SATS),
        script_pubkey: return_script.clone(),
    });
    psbt.outputs.push(Default::default());
    let prepared = color(borrower, chain, psbt, &loan.asset, recipient)?;
    let return_vout = output_index(&prepared.psbt, &return_script)?;
    require(
        prepared.psbt.unsigned_tx.output[return_vout as usize]
            .value
            .to_sat()
            == C_SATS,
        "borrower return changed",
    )?;
    require(
        unsigned(&prepared.psbt),
        "repayment signed before independent validation",
    )?;
    rgb_validate(lender, &prepared.psbt, &loan.asset, prepared.rgb_vout, DEBT)?;
    require(
        rgb_validate(
            lender,
            &prepared.psbt,
            &loan.asset,
            prepared.rgb_vout,
            DEBT + 1,
        )
        .is_err(),
        "invalid RGB amount accepted",
    )?;
    let weak = [
        TapSighashType::None,
        TapSighashType::Single,
        TapSighashType::AllPlusAnyoneCanPay,
        TapSighashType::NonePlusAnyoneCanPay,
        TapSighashType::SinglePlusAnyoneCanPay,
    ];
    for kind in weak {
        let mut forged = prepared.psbt.clone();
        forged.inputs[c_index].sighash_type = Some(kind.into());
        require(sighashes(&forged).is_err(), "weak sighash policy bypass")?;
    }
    let mut all = prepared.psbt.clone();
    all.inputs[c_index].sighash_type = Some(TapSighashType::All.into());
    sighashes(&all)?;
    let proof = hold_proof(lender, &prepared, &loan.asset)?;
    let prevouts = prevouts(&prepared.psbt)?;
    // L's signature is withheld until L validates the unsigned RGB transition and full Bitcoin policy.
    bitcoin_policy(chain, &prepared.psbt)?;
    let b = loan
        .collateral
        .signature(&prepared.psbt.unsigned_tx, &prevouts, c_index, false)?;
    let l = loan
        .collateral
        .signature(&prepared.psbt.unsigned_tx, &prevouts, c_index, true)?;
    let witness = loan.collateral.witness(b, l)?;
    let mut signed = prepared.psbt.clone();
    signed.inputs[c_index].final_script_witness = Some(witness.clone());
    let signed = native_sign(borrower, &signed)?;
    require(
        signed.inputs[c_index].final_script_witness.as_ref() == Some(&witness),
        "native signer changed C witness",
    )?;
    let transaction = extract(signed)?;
    require(
        chain.verdict(&transaction)?["allowed"] == true,
        "joint repayment rejected",
    )?;
    let mut missing = transaction.clone();
    let mut items = missing.input[c_index].witness.to_vec();
    items[0] = vec![];
    missing.input[c_index].witness = Witness::from_slice(&items);
    let missing_lender = chain.verdict(&missing)?;
    require(
        missing_lender["allowed"] == false,
        "missing lender signature accepted",
    )?;
    let mut changed_return = transaction.clone();
    changed_return.output[return_vout as usize].value = Amount::from_sat(C_SATS - 1);
    require(
        loan.collateral
            .verify_witness(&changed_return, &prevouts, c_index)
            .is_err(),
        "C signatures survived borrower return mutation",
    )?;
    let changed_return = chain.verdict(&changed_return)?;
    require(
        changed_return["allowed"] == false,
        "post-sign return mutation accepted",
    )?;
    let mut changed_commitment = transaction.clone();
    changed_commitment.output[0].script_pubkey = ScriptBuf::new_op_return([9; 32]);
    require(
        loan.collateral
            .verify_witness(&changed_commitment, &prevouts, c_index)
            .is_err(),
        "C signatures survived RGB commitment mutation",
    )?;
    let changed_commitment = chain.verdict(&changed_commitment)?;
    require(
        changed_commitment["allowed"] == false,
        "post-sign RGB commitment mutation accepted",
    )?;
    Ok(Repayment {
        prepared,
        proof,
        transaction,
        c_index,
        return_vout,
        negatives: json!({"invalid_rgb_amount":"rejected before signing",
        "weak_sighashes":"NONE,SINGLE,ALL|ANYONECANPAY,NONE|ANYONECANPAY,SINGLE|ANYONECANPAY rejected by policy; DEFAULT and ALL accepted",
        "missing_lender_signature":missing_lender,"c_signatures_commit_to_return_and_rgb":true,"modified_return_after_signing":changed_return,"modified_commitment_after_signing":changed_commitment}),
    })
}
fn onward(lender: &mut Party, sink: &mut Party, chain: &Chain, asset: &str) -> Result<Value> {
    let (_, outpoint, _) = send_asset(lender, sink, chain, asset, ONWARD, None)?;
    let lender_balance = lender.settled(asset, DEBT - ONWARD)?;
    Ok(
        json!({"txid":outpoint.txid.to_string(),"lender":lender_balance,"receiver":sink.balance(asset)?}),
    )
}
fn conflict_rejected(value: &Value) -> bool {
    value["allowed"] == false
        && value["reject-reason"].as_str().is_some_and(|why| {
            why.contains("missing") || why.contains("spent") || why.contains("conflict")
        })
}
fn run(data: &Path, source_commit: &str) -> Result<()> {
    let chain = Chain {
        client: reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?,
    };
    require(
        chain.rpc(false, "getblockchaininfo", json!([]))?["chain"] == "regtest",
        "regtest only",
    )?;
    let started = now();
    let mut issuer = Party::create(&data.join("issuer"), &chain)?;
    let mut borrower = Party::create(&data.join("borrower"), &chain)?;
    let mut lender = Party::create(&data.join("lender"), &chain)?;
    let mut sink = Party::create(&data.join("sink"), &chain)?;
    println!("joint origination: repayment-wins case");
    let loan = originate(&mut issuer, &mut lender, &mut borrower, &chain, "JRWIN")?;
    let repayment = prepare_repayment(&mut borrower, &mut lender, &chain, &loan)?;
    let early = chain.verdict(&loan.default)?;
    require(
        early["allowed"] == false
            && early["reject-reason"]
                .as_str()
                .is_some_and(|why| why.contains("non-final")),
        "early default accepted",
    )?;
    // Both alternatives are consensus-valid at the same height before either is mined.
    chain.mine(loan.default_height - chain.height()? + 1)?;
    let mature_default = chain.verdict(&loan.default)?;
    require(
        mature_default["allowed"] == true,
        "pre-signed future default invalid after origination",
    )?;
    require(
        chain.verdict(&repayment.transaction)?["allowed"] == true,
        "repayment invalid at default height",
    )?;
    let settled = confirm(
        &mut borrower,
        &mut lender,
        &chain,
        &loan.asset,
        &repayment.prepared,
        &repayment.proof,
        &repayment.transaction,
    )?;
    let borrower_balance = borrower.settled(&loan.asset.asset, 0)?;
    let return_outpoint = OutPoint {
        txid: repayment.transaction.compute_txid(),
        vout: repayment.return_vout,
    };
    require(
        chain.unspent(return_outpoint)?,
        "borrower BTC return not created",
    )?;
    let default_after_repayment = chain.verdict(&loan.default)?;
    require(
        conflict_rejected(&default_after_repayment),
        "default accepted after repayment confirmed",
    )?;
    let onward = onward(&mut lender, &mut sink, &chain, &loan.asset.asset)?;
    let repayment_wins = json!({"asset_id":loan.asset.asset,"origination":loan.origin,
        "context_commitment":loan.collateral.context.to_vec(),"principal_and_debt":DEBT,"collateral_sats":C_SATS,
        "repayment":settled,"borrower_rgb_balance":borrower_balance,"borrower_return_outpoint":return_outpoint.to_string(),
        "borrower_return_sats":C_SATS,"c_input_index":repayment.c_index,"independent_unsigned_repayment_validation":true,
        "early_default":early,"mature_default_before_repayment":mature_default,"default_after_repayment":default_after_repayment,
        "onward":onward,"negative_checks":repayment.negatives});
    println!("joint origination: default-wins case");
    let loan = originate(&mut issuer, &mut lender, &mut borrower, &chain, "JDWIN")?;
    let repayment = prepare_repayment(&mut borrower, &mut lender, &chain, &loan)?;
    chain.mine(loan.default_height - chain.height()? + 1)?;
    require(
        chain.verdict(&loan.default)?["allowed"] == true,
        "second mature default rejected",
    )?;
    require(
        chain.verdict(&repayment.transaction)?["allowed"] == true,
        "second competing repayment rejected",
    )?;
    chain.broadcast(&loan.default)?;
    let repayment_after_default = chain.verdict(&repayment.transaction)?;
    require(
        conflict_rejected(&repayment_after_default),
        "repayment accepted after default confirmed",
    )?;
    require(
        chain.unspent(loan.asset.outpoint)?,
        "default consumed borrower RGB input",
    )?;
    // Test cleanup after the conflicting default has CONFIRMED, not abort-before-signature/export.
    // Repayment is already fully signed. A default reorg could make it valid again; this fixture
    // does not establish reorg-safe cleanup, reservation release or production recovery semantics.
    borrower
        .wallet
        .psbt_op_abort(borrower.online.clone(), &repayment.prepared.operation)?;
    let borrower_balance = borrower.settled(&loan.asset.asset, DEBT)?;
    let lender_balance = lender.settled(&loan.asset.asset, 0)?;
    let return_outpoint = OutPoint {
        txid: repayment.transaction.compute_txid(),
        vout: repayment.return_vout,
    };
    require(
        !chain.unspent(return_outpoint)?,
        "unconfirmed repayment produced BTC return",
    )?;
    let default_wins = json!({"asset_id":loan.asset.asset,"origination":loan.origin,"default_txid":loan.default.compute_txid().to_string(),
        "repayment_after_default":repayment_after_default,"borrower_rgb_input_unspent":true,"borrower_rgb_balance":borrower_balance,
        "lender_rgb_balance":lender_balance,"repayment_return_absent":true});
    let report = json!({"status":"passed","kind":"independent-native-direct-joint-capability-spike","fork_commit":PIN,
        "source_commit":source_commit,"network":"regtest","internal_key":NUMS,"input_policy":"single-nia-exact-debt/v1",
        "repayment_wins":repayment_wins,"default_wins":default_wins,"duration_seconds":now()-started,
        "limitations":["Standalone fresh native-wallet capability only, no merged G0 interface or application adapter.",
            "Collateral is a demonstration 2-of-2 leaf with a context prefix; the pre-signed default uses nLockTime. No liquidation/governance policy acceptance.",
            "One exact-debt NIA input, no RGB change or additional colored inputs. No WDK-issued asset compatibility proof.",
            "Actors are separate wallets but run in one process; remote custody isolation, restart recovery and phone-local signing are not proven.",
            "Default-wins abort is fixture cleanup after a confirmed conflicting spend of C. Repayment signatures already exist; reorg-safe reservation release and recovery are not proven.",
            "NUMS safety relies on the standard discrete-log assumption. No secret-E or HTLC is used."]});
    fs::write(
        data.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
fn main() -> Result<()> {
    let data = PathBuf::from(
        env::var("PASSBOOK_JOINT_DATA_DIR")
            .map_err(|_| "set a NEW isolated PASSBOOK_JOINT_DATA_DIR")?,
    );
    let source_commit =
        env::var("PASSBOOK_JOINT_SOURCE_COMMIT").map_err(|_| "set tested source commit")?;
    require(
        source_commit.len() == 40 && source_commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid source commit",
    )?;
    require(
        !data.exists(),
        "preserve the previous run and use a fresh directory",
    )?;
    fs::create_dir_all(&data)?;
    run(&data, &source_commit)
}
