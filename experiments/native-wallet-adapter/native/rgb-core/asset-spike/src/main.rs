//! Supplemental raw-fork asset fixture only: no G0/G4 adapter, payment-for-K contract or loan.
//! Public synthetic receipt metadata; fresh native wallets, isolated local regtest endpoints.
use rgb_lib::{
    AssetSchema, Assignment, BitcoinNetwork, TransferStatus,
    bitcoin::{
        OutPoint, Transaction,
        consensus::encode::{deserialize_hex, serialize_hex},
        hashes::{Hash, sha256},
        psbt::Psbt,
    },
    keys::{WitnessVersion, generate_keys},
    utils::script_buf_from_recipient_id,
    wallet::{
        AssetFilter, AssetUDA, DatabaseType, Invoice, Online, OnlineOptions, Recipient,
        RgbWalletOpsOffline, RgbWalletOpsOnline, SinglesigKeys, Wallet, WalletData, WitnessData,
    },
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    str::FromStr,
    thread::sleep,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PIN: &str = "5f655a9cd02d23996d4d79e6d5f4e6add0301197";
const ELECTRUM: &str = "127.0.0.1:50301";
const PROXY: &str = "rpc://127.0.0.1:3400/json-rpc";
const CARRIER_SATS: u64 = 1000;
const FEE_RATE: u64 = 2;
fn ensure(ok: bool, why: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(std::io::Error::other(why).into())
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn digest(bytes: &[u8]) -> String {
    sha256::Hash::hash(bytes).to_string()
}
struct Chain {
    client: reqwest::blocking::Client,
}
impl Chain {
    fn rpc(&self, miner: bool, method: &str, params: Value) -> Result<Value> {
        let url = if miner {
            "http://127.0.0.1:18743/wallet/miner"
        } else {
            "http://127.0.0.1:18743"
        };
        let response: Value = self
            .client
            .post(url)
            .basic_auth("user", Some("password"))
            .json(&json!({"jsonrpc":"2.0","id":"asset-spike","method":method,"params":params}))
            .send()?
            .json()?;
        ensure(
            response["error"].is_null(),
            &format!("Bitcoin {method}: {}", response["error"]),
        )?;
        Ok(response["result"].clone())
    }
    fn height(&self) -> Result<u64> {
        self.rpc(false, "getblockcount", json!([]))?
            .as_u64()
            .ok_or("height missing".into())
    }
    fn indexed(&self) -> Result<()> {
        let target = self.height()?;
        for _ in 0..120 {
            let observed = (|| -> Result<u64> {
                let mut stream = TcpStream::connect(ELECTRUM)?;
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                stream.write_all(
                    b"{\"id\":1,\"method\":\"blockchain.headers.subscribe\",\"params\":[]}\n",
                )?;
                let mut line = String::new();
                BufReader::new(stream).read_line(&mut line)?;
                serde_json::from_str::<Value>(&line)?["result"]["height"]
                    .as_u64()
                    .ok_or("indexer tip missing".into())
            })();
            if observed.is_ok_and(|tip| tip >= target) {
                return Ok(());
            }
            sleep(Duration::from_millis(250));
        }
        Err("isolated indexer did not reach miner tip".into())
    }
    fn mine(&self, blocks: u32) -> Result<()> {
        let address = self.rpc(true, "getnewaddress", json!([]))?;
        self.rpc(true, "generatetoaddress", json!([blocks, address]))?;
        self.indexed()
    }
    fn raw(&self, txid: &str) -> Result<Transaction> {
        let raw = self.rpc(false, "getrawtransaction", json!([txid]))?;
        Ok(deserialize_hex(
            raw.as_str().ok_or("raw transaction missing")?,
        )?)
    }
    fn verdict(&self, tx: &Transaction) -> Result<Value> {
        Ok(self.rpc(false, "testmempoolaccept", json!([[serialize_hex(tx)]]))?[0].clone())
    }
    fn metrics(&self, tx: &Transaction) -> Result<Value> {
        let mut input_sats = 0u64;
        for input in &tx.input {
            let parent = self.raw(&input.previous_output.txid.to_string())?;
            input_sats = input_sats
                .checked_add(
                    parent
                        .output
                        .get(input.previous_output.vout as usize)
                        .ok_or("input vout missing")?
                        .value
                        .to_sat(),
                )
                .ok_or("input sum overflow")?;
        }
        let output_sats: u64 = tx.output.iter().map(|out| out.value.to_sat()).sum();
        let fee = input_sats
            .checked_sub(output_sats)
            .ok_or("negative miner fee")?;
        ensure(fee > 0 && fee <= 10_000, "unexpected fixture miner fee")?;
        Ok(
            json!({"txid":tx.compute_txid().to_string(),"input_sats":input_sats,"output_sats":output_sats,
            "fee_sats":fee,"signed_vsize":tx.vsize(),"observed_fee_sat_per_vb":fee as f64/tx.vsize() as f64,
            "requested_fee_sat_per_vb":FEE_RATE,"outputs":tx.output.iter().map(|out|json!({"sats":out.value.to_sat(),
                "kind":if out.script_pubkey.is_op_return(){"op_return"}else if out.script_pubkey.is_p2tr(){"p2tr"}else{"other"}})).collect::<Vec<_>>() }),
        )
    }
}
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
                supported_schemas: vec![AssetSchema::Nia, AssetSchema::Uda],
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
        wallet.create_utxos(online.clone(), false, Some(5), Some(5000), FEE_RATE, false)?;
        chain.mine(1)?;
        Ok(Self { wallet, online })
    }
    fn refresh(&mut self) -> Result<()> {
        self.wallet
            .refresh(self.online.clone(), None, vec![], false)?;
        Ok(())
    }
    fn balance(&self, asset: &str) -> Result<Value> {
        let balance = self.wallet.get_asset_balance(asset.to_owned())?;
        Ok(json!({"settled":balance.settled,"spendable":balance.spendable,"future":balance.future}))
    }
    fn wait_balance(&mut self, asset: &str, amount: u64) -> Result<Value> {
        for _ in 0..40 {
            self.refresh()?;
            let balance = self.balance(asset)?;
            if balance["settled"] == amount && balance["spendable"] == amount {
                return Ok(balance);
            }
            sleep(Duration::from_millis(250));
        }
        Err(format!("unexpected balance: {}", self.balance(asset)?).into())
    }
    fn receive(
        &mut self,
        asset: Option<String>,
        assignment: Assignment,
        blind: bool,
    ) -> Result<String> {
        let received = if blind {
            self.wallet
                .blind_receive(asset, assignment, now() + 3600, vec![PROXY.to_owned()], 1)?
        } else {
            self.wallet.witness_receive(
                asset,
                assignment,
                now() + 3600,
                vec![PROXY.to_owned()],
                1,
            )?
        };
        Ok(received.invoice)
    }
    fn held_uda(&self, asset: &str) -> Result<AssetUDA> {
        self.wallet
            .list_assets(vec![AssetSchema::Uda])?
            .uda
            .unwrap_or_default()
            .into_iter()
            .find(|item| item.asset_id == asset)
            .ok_or("held UDA missing".into())
    }
}
fn check_receipt(data: &Value) -> Result<()> {
    let object = data.as_object().ok_or("receipt must be an object")?;
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    ensure(
        keys == vec![
            "commitment",
            "date",
            "evidence_digest",
            "kind",
            "operator_pk",
            "release_hash",
            "tier",
            "v",
        ],
        "receipt has unexpected fields",
    )?;
    ensure(
        data["v"] == 1 && data["kind"] == "passbook-check-receipt",
        "receipt kind/version",
    )?;
    for key in [
        "commitment",
        "evidence_digest",
        "release_hash",
        "operator_pk",
    ] {
        let text = data[key].as_str().ok_or("receipt hash missing")?;
        ensure(
            text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid receipt hash",
        )?;
    }
    ensure(
        matches!(
            data["tier"].as_str(),
            Some("software-evidence" | "tee-attested")
        ),
        "receipt tier",
    )?;
    let date = data["date"].as_str().ok_or("date missing")?;
    ensure(
        date.len() == 10
            && date.as_bytes()[4] == b'-'
            && date.as_bytes()[7] == b'-'
            && date
                .bytes()
                .enumerate()
                .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit()),
        "receipt date",
    )
}
struct Prepared {
    signed: String,
    transaction: Transaction,
    invoice: String,
    recipient: String,
    carrier_vout: Option<u32>,
    metrics: Value,
}
fn prepare(
    sender: &mut Party,
    chain: &Chain,
    invoice: &str,
    asset: &str,
    assignment: Assignment,
    donation: bool,
    dry_run: bool,
) -> Result<Prepared> {
    let decoded = Invoice::new(invoice.to_owned())?.invoice_data();
    ensure(
        decoded.network == BitcoinNetwork::Regtest,
        "invoice network mismatch",
    )?;
    ensure(
        decoded.asset_id.as_deref().is_none_or(|id| id == asset),
        "invoice names another asset",
    )?;
    let script = script_buf_from_recipient_id(decoded.recipient_id.clone())?;
    let sent = sender.wallet.send_begin(
        sender.online.clone(),
        HashMap::from([(
            asset.to_owned(),
            vec![Recipient {
                recipient_id: decoded.recipient_id.clone(),
                assignment,
                witness_data: script.as_ref().map(|_| WitnessData {
                    amount_sat: CARRIER_SATS,
                    blinding: None,
                }),
                transport_endpoints: decoded.transport_endpoints,
            }],
        )]),
        donation,
        FEE_RATE,
        1,
        decoded
            .expiration_timestamp
            .ok_or("invoice expiry missing")?,
        dry_run,
        None,
    )?;
    let before = sender.wallet.inspect_psbt(sent.psbt.clone())?;
    let signed = sender.wallet.sign_psbt(sent.psbt, None)?;
    let psbt = Psbt::from_str(&signed)?;
    ensure(
        psbt.inputs
            .iter()
            .all(|input| input.final_script_witness.is_some()),
        "native inputs not finalized",
    )?;
    let transaction = psbt.extract_tx()?;
    let metrics = chain.metrics(&transaction)?;
    ensure(
        metrics["fee_sats"] == before.fee_sat,
        "PSBT fee differs from real prevouts",
    )?;
    let carrier_vout = script
        .as_ref()
        .map(|script| {
            transaction
                .output
                .iter()
                .position(|out| &out.script_pubkey == script)
                .ok_or("recipient carrier missing")
        })
        .transpose()?
        .map(|vout| vout as u32);
    if let Some(vout) = carrier_vout {
        ensure(
            transaction.output[vout as usize].value.to_sat() == CARRIER_SATS,
            "carrier value changed",
        )?;
    }
    Ok(Prepared {
        signed,
        transaction,
        invoice: invoice.to_owned(),
        recipient: decoded.recipient_id,
        carrier_vout,
        metrics,
    })
}
fn settle(
    sender: &mut Party,
    receiver: &mut Party,
    chain: &Chain,
    prepared: &Prepared,
    asset: &str,
    expected_receiver: u64,
) -> Result<Value> {
    let result = sender
        .wallet
        .send_end(sender.online.clone(), prepared.signed.clone())?;
    ensure(
        result.txid == prepared.transaction.compute_txid().to_string(),
        "send_end changed transaction id",
    )?;
    let mut broadcast = false;
    for _ in 0..40 {
        receiver.refresh()?;
        sender.refresh()?;
        if chain.raw(&result.txid).is_ok() {
            broadcast = true;
            break;
        }
        sleep(Duration::from_millis(250));
    }
    ensure(broadcast, "transfer did not broadcast after ACK")?;
    chain.mine(1)?;
    let balance = receiver.wait_balance(asset, expected_receiver)?;
    sender.refresh()?;
    let incoming = receiver
        .wallet
        .list_transfers(AssetFilter::Id(asset.to_owned()), Some(result.txid.clone()))?
        .into_iter()
        .find(|transfer| transfer.recipient_id.as_deref() == Some(prepared.recipient.as_str()))
        .ok_or("exact incoming receipt missing")?;
    ensure(
        incoming.status == TransferStatus::Settled,
        "exact incoming transfer not settled",
    )?;
    ensure(
        incoming.invoice_string.as_deref() == Some(prepared.invoice.as_str()),
        "receive invoice binding changed",
    )?;
    Ok(
        json!({"txid":result.txid,"status":"Settled","balance":balance,"assignments":incoming.assignments,
        "recipient_carrier_vout":prepared.carrier_vout,"recipient_carrier_sats":prepared.carrier_vout.map(|_|CARRIER_SATS),"bitcoin":prepared.metrics}),
    )
}
fn receipt_payload(held: &AssetUDA, expected: &[u8], expected_details: &str) -> Result<Value> {
    ensure(
        held.ticker == "PBRCPT" && held.name == "Passbook check receipt" && held.precision == 0,
        "receipt asset metadata changed",
    )?;
    ensure(
        held.details.as_deref() == Some(expected_details),
        "receipt details changed",
    )?;
    let media = held
        .token
        .as_ref()
        .and_then(|token| token.media.as_ref())
        .ok_or("receipt token media missing")?;
    let bytes = fs::read(&media.file_path)?;
    ensure(bytes == expected, "receipt media bytes changed")?;
    ensure(
        digest(&bytes) == media.digest,
        "receipt media digest mismatch",
    )?;
    let value: Value = serde_json::from_slice(&bytes)?;
    check_receipt(&value)?;
    Ok(
        json!({"details":held.details,"media_sha256":media.digest,"mime":media.mime,"bytes":bytes.len(),
        "token_media":true,"asset_level_media_present":held.media.is_some(),"byte_identical":true,"closed_metadata":value}),
    )
}
/// Fixture policy only. Native RGB cannot infer the application's operator/price binding.
/// Every accepted contract ID here is the explicit operator-issued ID, never just ticker PBCHK.
fn redemption_policy(
    expected_asset: &str,
    actual_asset: &str,
    amount: u64,
    invoice: &str,
) -> Result<()> {
    ensure(
        actual_asset == expected_asset,
        "wrong operator voucher contract",
    )?;
    ensure(amount == 1, "voucher redemption must be exactly one unit")?;
    let decoded = Invoice::new(invoice.to_owned())?.invoice_data();
    ensure(
        decoded.network == BitcoinNetwork::Regtest
            && decoded.asset_id.as_deref() == Some(expected_asset),
        "redemption invoice is not operator's contract",
    )?;
    ensure(
        decoded.assignment == Assignment::Fungible(1),
        "redemption invoice amount differs",
    )
}
fn prepare_redemption(
    payer: &mut Party,
    chain: &Chain,
    expected_asset: &str,
    actual_asset: &str,
    amount: u64,
    invoice: &str,
) -> Result<Prepared> {
    redemption_policy(expected_asset, actual_asset, amount, invoice)?;
    prepare(
        payer,
        chain,
        invoice,
        actual_asset,
        Assignment::Fungible(amount),
        false,
        true,
    )
}
fn run(data: &Path, source_commit: &str) -> Result<()> {
    let chain = Chain {
        client: reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?,
    };
    ensure(
        chain.rpc(false, "getblockchaininfo", json!([]))?["chain"] == "regtest",
        "regtest only",
    )?;
    let started = now();
    let mut operator = Party::create(&data.join("operator"), &chain)?;
    let mut payer = Party::create(&data.join("payer"), &chain)?;
    println!("native UDA issuance and blinded receipt transfer");
    let fixture = include_bytes!("../fixtures/receipt.json");
    let receipt: Value = serde_json::from_slice(fixture)?;
    check_receipt(&receipt)?;
    ensure(
        serde_json::to_vec(&receipt)? == fixture,
        "fixture is not byte-canonical JSON",
    )?;
    let mut forbidden = receipt.clone();
    forbidden["outputs"] = json!({"synthetic":"not permitted"});
    ensure(
        check_receipt(&forbidden).is_err(),
        "closed schema allowed result fields",
    )?;
    let media_path = data.join("receipt-public-fixture.json");
    fs::write(&media_path, fixture)?;
    let details = format!("passbook-check-receipt/v1 sha256:{}", digest(fixture));
    ensure(details.len() <= 255, "details exceed schema limit")?;
    let height_before_issue = chain.height()?;
    let asset = operator.wallet.issue_asset_uda(
        "PBRCPT".to_owned(),
        "Passbook check receipt".to_owned(),
        Some(details.clone()),
        0,
        Some(media_path.to_str().ok_or("media path encoding")?.to_owned()),
        vec![],
    )?;
    ensure(
        chain.height()? == height_before_issue,
        "offline issuance unexpectedly mined",
    )?;
    let issued_metadata = receipt_payload(&asset, fixture, &details)?;
    ensure(
        asset.balance.settled == 1 && asset.balance.spendable == 1,
        "issued receipt not spendable",
    )?;
    let invoice = payer.receive(None, Assignment::Any, true)?;
    let prepared = prepare(
        &mut operator,
        &chain,
        &invoice,
        &asset.asset_id,
        Assignment::NonFungible,
        false,
        false,
    )?;
    let receipt_send = settle(
        &mut operator,
        &mut payer,
        &chain,
        &prepared,
        &asset.asset_id,
        1,
    )?;
    ensure(
        receipt_send["assignments"] == json!(["NonFungible"]),
        "incoming UDA assignment changed",
    )?;
    operator.wait_balance(&asset.asset_id, 0)?;
    let held = payer.held_uda(&asset.asset_id)?;
    let received_metadata = receipt_payload(&held, fixture, &details)?;
    ensure(
        issued_metadata["media_sha256"] == received_metadata["media_sha256"],
        "media digest changed during transfer",
    )?;
    println!("native NIA voucher distribution and exact-one redemption");
    let voucher = operator.wallet.issue_asset_nia(
        "PBCHK".to_owned(),
        "PBCHK public operator fixture".to_owned(),
        0,
        vec![100],
    )?;
    let invoice = payer.receive(None, Assignment::Fungible(3), false)?;
    let distributed = prepare(
        &mut operator,
        &chain,
        &invoice,
        &voucher.asset_id,
        Assignment::Fungible(3),
        false,
        false,
    )?;
    let voucher_seal = OutPoint {
        txid: distributed.transaction.compute_txid(),
        vout: distributed
            .carrier_vout
            .ok_or("voucher witness carrier missing")?,
    };
    let distribution = settle(
        &mut operator,
        &mut payer,
        &chain,
        &distributed,
        &voucher.asset_id,
        3,
    )?;
    operator.wait_balance(&voucher.asset_id, 97)?;
    // A different valid NIA with the same ticker is not this operator's accepted contract.
    let foreign = payer.wallet.issue_asset_nia(
        "PBCHK".to_owned(),
        "PBCHK unrelated fixture".to_owned(),
        0,
        vec![5],
    )?;
    let invoice_a = operator.receive(
        Some(voucher.asset_id.clone()),
        Assignment::Fungible(1),
        false,
    )?;
    let before = chain.height()?;
    let transfers_before = payer
        .wallet
        .list_transfers(AssetFilter::Id(voucher.asset_id.clone()), None)?
        .len();
    ensure(
        prepare_redemption(
            &mut payer,
            &chain,
            &voucher.asset_id,
            &foreign.asset_id,
            1,
            &invoice_a,
        )
        .is_err(),
        "foreign operator voucher accepted",
    )?;
    ensure(
        prepare_redemption(
            &mut payer,
            &chain,
            &voucher.asset_id,
            &voucher.asset_id,
            2,
            &invoice_a,
        )
        .is_err(),
        "wrong amount voucher accepted",
    )?;
    ensure(
        before == chain.height()?
            && transfers_before
                == payer
                    .wallet
                    .list_transfers(AssetFilter::Id(voucher.asset_id.clone()), None)?
                    .len(),
        "refused requests created transfer state",
    )?;
    payer.wait_balance(&voucher.asset_id, 3)?;
    let invoice_b = operator.receive(
        Some(voucher.asset_id.clone()),
        Assignment::Fungible(1),
        false,
    )?;
    // Both dry-run candidates are fully signed BEFORE either is broadcast. They consume the
    // same actual RGB seal but pay distinct invoice outputs. No fake exactly-once app ledger.
    let a = prepare_redemption(
        &mut payer,
        &chain,
        &voucher.asset_id,
        &voucher.asset_id,
        1,
        &invoice_a,
    )?;
    let b = prepare_redemption(
        &mut payer,
        &chain,
        &voucher.asset_id,
        &voucher.asset_id,
        1,
        &invoice_b,
    )?;
    for candidate in [&a, &b] {
        ensure(
            candidate
                .transaction
                .input
                .iter()
                .any(|input| input.previous_output == voucher_seal),
            "candidate did not spend the known voucher seal",
        )?;
        ensure(
            chain.verdict(&candidate.transaction)?["allowed"] == true,
            "pre-broadcast redemption candidate rejected",
        )?;
    }
    ensure(
        a.transaction.compute_txid() != b.transaction.compute_txid(),
        "alternative redemption transaction identical",
    )?;
    let redemption = settle(&mut payer, &mut operator, &chain, &a, &voucher.asset_id, 98)?;
    let payer_balance = payer.wait_balance(&voucher.asset_id, 2)?;
    let foreign_balance = payer.wait_balance(&foreign.asset_id, 5)?;
    let loser = chain.verdict(&b.transaction)?;
    ensure(
        loser["allowed"] == false
            && loser["reject-reason"].as_str().is_some_and(|why| {
                why.contains("missing") || why.contains("spent") || why.contains("conflict")
            }),
        "conflicting spent-seal redemption accepted",
    )?;
    ensure(
        chain
            .rpc(
                false,
                "gettxout",
                json!([voucher_seal.txid.to_string(), voucher_seal.vout, true]),
            )?
            .is_null(),
        "redeemed voucher seal remains unspent",
    )?;
    // Native API exposes burn, but this exact fork admits IFA only. Exercise the actual refusal.
    let burn_refusal = payer
        .wallet
        .burn_begin(
            payer.online.clone(),
            voucher.asset_id.clone(),
            1,
            FEE_RATE,
            1,
            true,
        )
        .err()
        .ok_or("NIA burn unexpectedly supported")?;
    let burn_refusal = format!("{burn_refusal:?}");
    ensure(
        burn_refusal.contains("UnsupportedBurn"),
        "NIA burn failed for an unexpected reason",
    )?;
    let report = json!({"status":"passed","kind":"independent-native-receipt-voucher-capability-spike","source_commit":source_commit,
        "fork_commit":PIN,"network":"regtest","duration_seconds":now()-started,
        "receipt":{"asset_id":asset.asset_id,"issued":issued_metadata,"receive":receipt_send,"held":received_metadata,
            "operator_balance":operator.balance(&asset.asset_id)?,"payer_balance":payer.balance(&asset.asset_id)?},
        "voucher":{"asset_id":voucher.asset_id,"issued":100,"sent_to_payer":3,"distribution":distribution,
            "redeemed":1,"redemption":redemption,"operator_balance":operator.balance(&voucher.asset_id)?,"payer_balance":payer_balance,
            "foreign_same_ticker_contract":foreign.asset_id,"foreign_balance_preserved":foreign_balance,
            "spent_rgb_seal":voucher_seal.to_string(),"both_candidates_bitcoin_acceptable_before_spend":true,"conflicting_redemption_after_confirmation":loser},
        "negative_checks":{"wrong_operator_contract":"fixture policy rejected before native prepare/sign/transfer",
            "wrong_amount":"fixture policy rejected before native prepare/sign/transfer","refusals_preserved_transfer_count":true,
            "receipt_extra_result_field":"closed fixture schema rejected","nia_burn":burn_refusal},
        "limits":["Standalone new native wallets/assets only; no G0/G4 adapter, Nostr/scorer wiring, check K delivery or payment fair-exchange acceptance.",
            "Bitcoin rejects two confirmed spends of the same seal. This is not a durable application exactly-once redemption journal or reorg-safe recovery proof.",
            "NIA is transferred, not burned: total voucher supply remains100. Operator now holds98 and could intentionally redistribute inventory.",
            "Wallet states are separate but in one process. WDK/RLN historical asset compatibility, phone-local adapter and restart recovery are not proven.",
            "BTC metrics are actual regtest transaction fees/carrier funding, not product price/performance claims; offline issuance uses previously funded colorable UTXOs."]});
    fs::write(
        data.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
fn main() -> Result<()> {
    let data = PathBuf::from(
        env::var("PASSBOOK_ASSETS_DATA_DIR").map_err(|_| "set a NEW isolated data directory")?,
    );
    let source =
        env::var("PASSBOOK_ASSETS_SOURCE_COMMIT").map_err(|_| "set frozen source commit")?;
    ensure(
        source.len() == 40 && source.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid source commit",
    )?;
    ensure(
        !data.exists(),
        "previous run exists; preserve it and choose a fresh directory",
    )?;
    fs::create_dir_all(&data)?;
    run(&data, &source)
}
