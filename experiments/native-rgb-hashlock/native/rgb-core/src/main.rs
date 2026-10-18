//! Independent G1 capability spike, not a loan protocol or production signer.
//! The RGB library owns fresh native wallets; no WDK databases or phone keys are opened.

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

use rgb_lib::{
    AssetSchema, Assignment, BitcoinNetwork, ContractId, TransferStatus,
    bitcoin::{
        self, Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness,
        absolute::LockTime,
        consensus::encode::serialize_hex,
        hashes::{Hash, sha256},
        key::{Keypair, XOnlyPublicKey},
        opcodes::all::{OP_CHECKSIG, OP_CLTV, OP_DROP, OP_EQUALVERIFY, OP_SHA256, OP_SIZE},
        psbt::{Input, Psbt},
        script::Builder,
        secp256k1::{Message, Secp256k1, SecretKey},
        sighash::{Prevouts, SighashCache, TapSighashType},
        taproot::{LeafVersion, TapLeafHash, TaprootBuilder, TaprootSpendInfo},
    },
    keys::{WitnessVersion, generate_keys},
    utils::{recipient_id_from_script_buf, script_buf_from_recipient_id},
    wallet::{
        AssetFilter, DatabaseType, Online, OnlineOptions, Recipient, RgbWalletOpsOffline,
        RgbWalletOpsOnline, SinglesigKeys, Wallet, WalletData, WitnessData,
        rust_only::{AssetColoringInfo, ColoringInfo, ExpectedTransfer, PsbtOpExpiry},
    },
};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PIN: &str = "5f655a9cd02d23996d4d79e6d5f4e6add0301197";
// Exactly the existing BIP341 NUMS key in src/escrow/escrow.ts, copied as a public constant.
const NUMS: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const SUPPLY: u64 = 666;
const DEBT: u64 = 600;
const ONWARD: u64 = 66;
const BOX_SATS: u64 = 1_000;
const BLINDING: u64 = 4_242;

fn ensure(ok: bool, message: &str) -> Result<()> {
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
    rpc: String,
    electrum: String,
    proxy: String,
    client: reqwest::blocking::Client,
}

impl Chain {
    fn rpc_at(&self, wallet: bool, method: &str, params: Value) -> Result<Value> {
        let url = if wallet {
            format!("{}/wallet/miner", self.rpc)
        } else {
            self.rpc.clone()
        };
        let response: Value = self
            .client
            .post(url)
            .basic_auth("user", Some("password"))
            .json(&json!({"jsonrpc":"2.0", "id":"passbook-g1", "method":method, "params":params}))
            .send()?
            .json()?;
        ensure(
            response["error"].is_null(),
            &format!("Bitcoin {method}: {}", response["error"]),
        )?;
        Ok(response["result"].clone())
    }
    fn height(&self) -> Result<u32> {
        Ok(self
            .rpc_at(false, "getblockcount", json!([]))?
            .as_u64()
            .ok_or("missing block height")? as u32)
    }
    fn wait_indexer(&self) -> Result<()> {
        let height = self.height()?;
        for _ in 0..120 {
            let result = (|| -> Result<u64> {
                let mut stream = TcpStream::connect(&self.electrum)?;
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                stream.write_all(
                    b"{\"id\":1,\"method\":\"blockchain.headers.subscribe\",\"params\":[]}\n",
                )?;
                let mut line = String::new();
                BufReader::new(stream).read_line(&mut line)?;
                Ok(serde_json::from_str::<Value>(&line)?["result"]["height"]
                    .as_u64()
                    .ok_or("missing indexer height")?)
            })();
            if result.is_ok_and(|tip| tip >= height as u64) {
                return Ok(());
            }
            sleep(Duration::from_millis(250));
        }
        Err("isolated electrs did not reach the miner tip".into())
    }
    fn mine(&self, blocks: u32) -> Result<()> {
        let address = self.rpc_at(true, "getnewaddress", json!([]))?;
        self.rpc_at(true, "generatetoaddress", json!([blocks, address]))?;
        self.wait_indexer()
    }
    fn fund(&self, address: String) -> Result<()> {
        self.rpc_at(true, "sendtoaddress", json!([address, 0.1]))?;
        self.mine(1)
    }
    fn transaction(&self, txid: &str) -> Result<Transaction> {
        let raw = self.rpc_at(false, "getrawtransaction", json!([txid]))?;
        Ok(bitcoin::consensus::encode::deserialize_hex(
            raw.as_str().ok_or("missing raw transaction")?,
        )?)
    }
    fn verdict(&self, transaction: &Transaction) -> Result<Value> {
        Ok(self.rpc_at(
            false,
            "testmempoolaccept",
            json!([[serialize_hex(transaction)]]),
        )?[0]
            .clone())
    }
    fn broadcast(&self, transaction: &Transaction) -> Result<String> {
        Ok(self
            .rpc_at(
                false,
                "sendrawtransaction",
                json!([serialize_hex(transaction)]),
            )?
            .as_str()
            .ok_or("missing broadcast txid")?
            .to_owned())
    }
}

struct Party {
    wallet: Wallet,
    online: Online,
}
impl Party {
    fn fresh(path: &Path, chain: &Chain) -> Result<Self> {
        fs::create_dir(path)?;
        let keys = generate_keys(BitcoinNetwork::Regtest, WitnessVersion::Taproot);
        // Seeds are generated for these isolated test wallets only and never enter the report.
        let mut wallet = Wallet::new(
            WalletData {
                data_dir: path.to_str().ok_or("non UTF8 data path")?.to_owned(),
                bitcoin_network: BitcoinNetwork::Regtest,
                database_type: DatabaseType::Sqlite,
                max_allocations_per_utxo: 5,
                supported_schemas: vec![AssetSchema::Nia],
                reuse_addresses: false,
            },
            SinglesigKeys::from_keys(&keys, None),
        )?;
        let online = wallet.go_online(OnlineOptions {
            indexer_url: chain.electrum.clone(),
            skip_consistency_check: false,
            vanilla_sync_lookback: 20,
        })?;
        chain.fund(wallet.get_address()?)?;
        wallet.create_utxos(online.clone(), false, Some(5), Some(5_000), 2, false)?;
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
        Ok(
            json!({"settled":balance.settled, "spendable":balance.spendable, "future":balance.future}),
        )
    }
    fn wait_balance(&mut self, asset: &str, expected: u64) -> Result<Value> {
        for _ in 0..40 {
            self.refresh()?;
            let balance = self.balance(asset)?;
            if balance["settled"] == expected && balance["spendable"] == expected {
                return Ok(balance);
            }
            sleep(Duration::from_millis(250));
        }
        Err(format!("unexpected receiver balance: {}", self.balance(asset)?).into())
    }
}

/// SHA256 + exactly-32-byte secret + fixed NUMS; not the upstream HASH160/key-path fixture.
struct PaymentBox {
    secret: [u8; 32],
    claim_key: Keypair,
    refund_key: Keypair,
    refund_height: u32,
    claim_leaf: ScriptBuf,
    refund_leaf: ScriptBuf,
    tree: TaprootSpendInfo,
}
impl PaymentBox {
    fn new(refund_height: u32) -> Result<Self> {
        let secp = Secp256k1::new();
        // Fresh entropy from the OS; these secrets remain only in this test process.
        let random = || -> Result<[u8; 32]> {
            let mut value = [0; 32];
            std::io::Read::read_exact(&mut fs::File::open("/dev/urandom")?, &mut value)?;
            Ok(value)
        };
        let secret = random()?;
        let claim_key = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&random()?)?);
        let refund_key = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&random()?)?);
        let claim_leaf = Builder::new()
            .push_opcode(OP_SIZE)
            .push_int(32)
            .push_opcode(OP_EQUALVERIFY)
            .push_opcode(OP_SHA256)
            .push_slice(sha256::Hash::hash(&secret).to_byte_array())
            .push_opcode(OP_EQUALVERIFY)
            .push_x_only_key(&claim_key.x_only_public_key().0)
            .push_opcode(OP_CHECKSIG)
            .into_script();
        let refund_leaf = Builder::new()
            .push_int(refund_height as i64)
            .push_opcode(OP_CLTV)
            .push_opcode(OP_DROP)
            .push_x_only_key(&refund_key.x_only_public_key().0)
            .push_opcode(OP_CHECKSIG)
            .into_script();
        let tree = TaprootBuilder::new()
            .add_leaf(1, claim_leaf.clone())?
            .add_leaf(1, refund_leaf.clone())?
            .finalize(&secp, XOnlyPublicKey::from_str(NUMS)?)
            .map_err(|_| "invalid Taproot tree")?;
        Ok(Self {
            secret,
            claim_key,
            refund_key,
            refund_height,
            claim_leaf,
            refund_leaf,
            tree,
        })
    }
    fn script(&self) -> ScriptBuf {
        ScriptBuf::new_p2tr_tweaked(self.tree.output_key())
    }
    fn witness(
        &self,
        transaction: &Transaction,
        prevouts: &[TxOut],
        index: usize,
        refund: bool,
    ) -> Result<Witness> {
        let leaf = if refund {
            &self.refund_leaf
        } else {
            &self.claim_leaf
        };
        let key = if refund {
            &self.refund_key
        } else {
            &self.claim_key
        };
        let sighash = SighashCache::new(transaction).taproot_script_spend_signature_hash(
            index,
            &Prevouts::All(prevouts),
            TapLeafHash::from_script(leaf, LeafVersion::TapScript),
            TapSighashType::Default,
        )?;
        let signature = Secp256k1::new()
            .sign_schnorr_no_aux_rand(&Message::from_digest(sighash.to_byte_array()), key);
        let mut witness = Witness::new();
        witness.push(signature.as_ref());
        if !refund {
            witness.push(self.secret);
        }
        witness.push(leaf.as_bytes());
        witness.push(
            self.tree
                .control_block(&(leaf.clone(), LeafVersion::TapScript))
                .ok_or("missing control block")?
                .serialize(),
        );
        Ok(witness)
    }
}

struct Locked {
    asset: String,
    outpoint: OutPoint,
    txout: TxOut,
    recipient: String,
    payment_box: PaymentBox,
}

fn lock(sender: &mut Party, chain: &Chain, ticker: &str) -> Result<Locked> {
    let asset = sender
        .wallet
        .issue_asset_nia(
            ticker.to_owned(),
            "Passbook G1 test asset (no value)".to_owned(),
            0,
            vec![SUPPLY],
        )?
        .asset_id;
    let payment_box = PaymentBox::new(chain.height()? + 30)?;
    let script = payment_box.script();
    let recipient = recipient_id_from_script_buf(script.clone(), BitcoinNetwork::Regtest)?;
    let sent = sender.wallet.send(
        sender.online.clone(),
        HashMap::from([(
            asset.clone(),
            vec![Recipient {
                recipient_id: recipient.clone(),
                witness_data: Some(WitnessData {
                    amount_sat: BOX_SATS,
                    blinding: Some(BLINDING),
                }),
                assignment: Assignment::Fungible(DEBT),
                transport_endpoints: vec![chain.proxy.clone()],
            }],
        )]),
        true,
        2,
        1,
        now() + 3600,
        None,
    )?;
    chain.mine(1)?;
    sender.refresh()?;
    let transaction = chain.transaction(&sent.txid)?;
    let index = transaction
        .output
        .iter()
        .position(|output| output.script_pubkey == script)
        .ok_or("box output missing")?;
    let outpoint = OutPoint {
        txid: transaction.compute_txid(),
        vout: index as u32,
    };
    println!("locked {ticker}: {outpoint}");
    Ok(Locked {
        asset,
        outpoint,
        txout: transaction.output[index].clone(),
        recipient,
        payment_box,
    })
}

fn accept_lock(receiver: &mut Party, chain: &Chain, locked: &Locked) -> Result<()> {
    let (consignment, assignments) = receiver.wallet.fetch_and_accept_transfer_by_recipient_id(
        receiver.online.clone(),
        locked.recipient.clone(),
        locked.recipient.clone(),
        &chain.proxy,
        BLINDING,
        1,
        ExpectedTransfer {
            asset_id: locked.asset.clone(),
            asset_schema: AssetSchema::Nia,
            assignment: Assignment::Fungible(DEBT),
        },
    )?;
    ensure(
        assignments == vec![Assignment::Fungible(DEBT)],
        "lock consignment amount mismatch",
    )?;
    receiver.wallet.save_new_asset(
        receiver.online.clone(),
        consignment,
        locked.outpoint.txid.to_string(),
    )?;
    Ok(())
}

struct Prepared {
    psbt: Psbt,
    operation: String,
    box_index: usize,
    recipient: String,
    output: u32,
}
fn prepare(receiver: &mut Party, chain: &Chain, locked: &Locked, refund: bool) -> Result<Prepared> {
    let received = receiver.wallet.witness_receive(
        Some(locked.asset.clone()),
        Assignment::Fungible(DEBT),
        now() + 3600,
        // This receive consumes the operation's local consignment through the explicit
        // handover API. A proxy-mode receive must instead be posted to the proxy/refreshed.
        vec![],
        1,
    )?;
    let script = script_buf_from_recipient_id(received.recipient_id.clone())?
        .ok_or("receive is not witness mode")?;
    let address = bitcoin::Address::from_script(&script, bitcoin::Network::Regtest)?.to_string();
    // Public API supplies wallet fee-input derivations. dry_run avoids creating an ordinary BTC send record.
    let mut psbt = Psbt::from_str(&receiver.wallet.send_btc_begin(
        receiver.online.clone(),
        address,
        BOX_SATS,
        2,
        false,
        true,
        None,
    )?)?;
    let box_index = psbt.inputs.len();
    psbt.unsigned_tx.input.push(TxIn {
        previous_output: locked.outpoint,
        script_sig: ScriptBuf::new(),
        sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
        witness: Witness::new(),
    });
    psbt.inputs.push(Input {
        witness_utxo: Some(locked.txout.clone()),
        ..Default::default()
    });
    // The box's 1,000 sats conservatively top up the miner fee for the external script witness.
    // There is no extra BTC payment to the lender: its witness output is exactly BOX_SATS.
    if refund {
        psbt.unsigned_tx.lock_time = LockTime::from_height(locked.payment_box.refund_height)?;
    }
    psbt.unsigned_tx.output.insert(
        0,
        TxOut {
            value: Amount::ZERO,
            script_pubkey: ScriptBuf::new_op_return([]),
        },
    );
    psbt.outputs.insert(0, Default::default());
    let output = psbt
        .unsigned_tx
        .output
        .iter()
        .position(|out| out.script_pubkey == script)
        .ok_or("receive output missing")? as u32;
    let coloring = ColoringInfo {
        asset_info_map: HashMap::from([(
            ContractId::from_str(&locked.asset)?,
            AssetColoringInfo {
                output_map: HashMap::from([(output, DEBT)]),
                static_blinding: Some(888),
            },
        )]),
        static_blinding: Some(888),
        nonce: None,
    };
    let operation = receiver.wallet.psbt_op_prepare_with_expiry(
        &mut psbt,
        coloring,
        vec![locked.outpoint],
        1,
        PsbtOpExpiry::Never,
    )?;
    let allocations = receiver.wallet.validate_htlc_spend(
        &psbt,
        ContractId::from_str(&locked.asset)?,
        locked.outpoint,
        DEBT,
        output,
        &chain.electrum,
    )?;
    ensure(allocations.len() == 1, "unexpected RGB allocations")?;
    ensure(
        receiver
            .wallet
            .validate_htlc_spend(
                &psbt,
                ContractId::from_str(&locked.asset)?,
                locked.outpoint,
                DEBT + 1,
                output,
                &chain.electrum,
            )
            .is_err(),
        "wrong RGB amount was accepted",
    )?;
    Ok(Prepared {
        psbt,
        operation: operation.operation_id,
        box_index,
        recipient: received.recipient_id,
        output,
    })
}

fn sign(
    receiver: &Party,
    locked: &Locked,
    prepared: &Prepared,
    refund: bool,
) -> Result<Transaction> {
    let mut psbt = prepared.psbt.clone();
    let prevouts: Vec<TxOut> = psbt
        .inputs
        .iter()
        .map(|input| input.witness_utxo.clone().ok_or("missing prevout"))
        .collect::<std::result::Result<_, _>>()?;
    let witness =
        locked
            .payment_box
            .witness(&psbt.unsigned_tx, &prevouts, prepared.box_index, refund)?;
    psbt.inputs[prepared.box_index].final_script_witness = Some(witness.clone());
    let signed = receiver.wallet.sign_psbt(psbt.to_string(), None)?;
    let finalized = Psbt::from_str(&receiver.wallet.finalize_psbt(signed, None)?)?;
    ensure(
        finalized.inputs[prepared.box_index]
            .final_script_witness
            .as_ref()
            == Some(&witness),
        "native signer changed HTLC witness",
    )?;
    Ok(finalized.extract_tx()?)
}

fn settle(
    receiver: &mut Party,
    chain: &Chain,
    locked: &Locked,
    prepared: &Prepared,
    transaction: &Transaction,
    expected: u64,
) -> Result<Value> {
    receiver
        .wallet
        .psbt_op_mark_broadcast(&prepared.operation)?;
    let txid = chain.broadcast(transaction)?;
    chain.wait_indexer()?;
    // Electrs can know the tip but need a moment to index the mempool transaction.
    chain.mine(1)?;
    receiver
        .wallet
        .psbt_op_apply(receiver.online.clone(), &prepared.operation)?;
    receiver.wallet.psbt_op_provide_receive_consignment(
        receiver.online.clone(),
        &prepared.operation,
        &locked.asset,
    )?;
    let balance = receiver.wait_balance(&locked.asset, expected)?;
    let receive = receiver
        .wallet
        .list_transfers(AssetFilter::Id(locked.asset.clone()), Some(txid.clone()))?
        .into_iter()
        .find(|transfer| transfer.recipient_id.as_deref() == Some(prepared.recipient.as_str()))
        .ok_or("incoming transfer missing")?;
    ensure(
        receive.status == TransferStatus::Settled,
        "incoming RGB transfer did not settle",
    )?;
    Ok(
        json!({"txid":txid, "operation_id":prepared.operation, "rgb_vout":prepared.output, "balance":balance, "status":"Settled"}),
    )
}

fn onward(sender: &mut Party, sink: &mut Party, chain: &Chain, asset: &str) -> Result<Value> {
    let received = sink.wallet.witness_receive(
        None,
        Assignment::Fungible(ONWARD),
        now() + 3600,
        vec![chain.proxy.clone()],
        1,
    )?;
    let sent = sender.wallet.send(
        sender.online.clone(),
        HashMap::from([(
            asset.to_owned(),
            vec![Recipient {
                recipient_id: received.recipient_id,
                witness_data: Some(WitnessData {
                    amount_sat: BOX_SATS,
                    blinding: None,
                }),
                assignment: Assignment::Fungible(ONWARD),
                transport_endpoints: vec![chain.proxy.clone()],
            }],
        )]),
        true,
        2,
        1,
        now() + 3600,
        None,
    )?;
    chain.mine(1)?;
    let sink_balance = sink.wait_balance(asset, ONWARD)?;
    let sender_balance = sender.wait_balance(asset, DEBT - ONWARD)?;
    Ok(json!({"txid":sent.txid,"sender":sender_balance,"receiver":sink_balance}))
}

fn main() -> Result<()> {
    let data = PathBuf::from(
        env::var("PASSBOOK_G1_DATA_DIR")
            .map_err(|_| "set PASSBOOK_G1_DATA_DIR to a NEW isolated run directory")?,
    );
    ensure(
        !data.exists(),
        "run directory already exists; preserve it and choose a new directory",
    )?;
    let chain = Chain {
        rpc: env::var("PASSBOOK_G1_RPC").unwrap_or_else(|_| "http://127.0.0.1:18713".to_owned()),
        electrum: env::var("PASSBOOK_G1_ELECTRUM").unwrap_or_else(|_| "127.0.0.1:50281".to_owned()),
        proxy: env::var("PASSBOOK_G1_PROXY")
            .unwrap_or_else(|_| "rpc://127.0.0.1:3380/json-rpc".to_owned()),
        client: reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?,
    };
    // Restrict every side effect to the explicitly reserved local regtest endpoints.
    ensure(
        chain.rpc == "http://127.0.0.1:18713"
            && chain.electrum == "127.0.0.1:50281"
            && chain.proxy == "rpc://127.0.0.1:3380/json-rpc",
        "this capability spike only supports its reserved isolated endpoints",
    )?;
    ensure(
        chain.rpc_at(false, "getblockchaininfo", json!([]))?["chain"] == "regtest",
        "refusing a non-regtest chain",
    )?;
    fs::create_dir_all(&data)?;
    let started = now();
    let mut sender = Party::fresh(&data.join("sender"), &chain)?;
    let mut lender = Party::fresh(&data.join("lender"), &chain)?;
    let mut sink = Party::fresh(&data.join("sink"), &chain)?;

    let claimed = lock(&mut sender, &chain, "G1CLM")?;
    accept_lock(&mut lender, &chain, &claimed)?;
    let prepared = prepare(&mut lender, &chain, &claimed, false)?;
    let transaction = sign(&lender, &claimed, &prepared, false)?;
    ensure(
        chain.verdict(&transaction)?["allowed"] == true,
        "correct claim rejected by Bitcoin",
    )?;
    let mut wrong_secret = transaction.clone();
    let mut witness = transaction.input[prepared.box_index].witness.to_vec();
    witness[1] = vec![0; 32];
    wrong_secret.input[prepared.box_index].witness = Witness::from_slice(&witness);
    let wrong_secret_verdict = chain.verdict(&wrong_secret)?;
    ensure(
        wrong_secret_verdict["allowed"] == false,
        "wrong preimage passed consensus",
    )?;
    let mut wrong_signature = transaction.clone();
    let mut witness = transaction.input[prepared.box_index].witness.to_vec();
    witness[0] = vec![0; 64];
    wrong_signature.input[prepared.box_index].witness = Witness::from_slice(&witness);
    let wrong_signature_verdict = chain.verdict(&wrong_signature)?;
    ensure(
        wrong_signature_verdict["allowed"] == false,
        "wrong signer passed consensus",
    )?;
    let mut keypath = transaction.clone();
    keypath.input[prepared.box_index].witness = Witness::from_slice(&[vec![0; 64]]);
    let keypath_verdict = chain.verdict(&keypath)?;
    ensure(
        keypath_verdict["allowed"] == false,
        "attempted keypath bypass passed consensus",
    )?;
    let claim = settle(&mut lender, &chain, &claimed, &prepared, &transaction, DEBT)?;
    let confirmed = chain.rpc_at(
        false,
        "getrawtransaction",
        json!([transaction.compute_txid().to_string(), true]),
    )?;
    ensure(
        confirmed["confirmations"].as_u64().unwrap_or(0) >= 1,
        "claim is not confirmed",
    )?;
    let confirmed_transaction = chain.transaction(&transaction.compute_txid().to_string())?;
    let confirmed_witness = confirmed_transaction.input[prepared.box_index]
        .witness
        .to_vec();
    let public_secret = &confirmed_witness[1];
    ensure(
        public_secret == &claimed.payment_box.secret,
        "confirmed claim did not reveal the original secret",
    )?;
    let onward = onward(&mut lender, &mut sink, &chain, &claimed.asset)?;

    sender.refresh()?;
    let refunded = lock(&mut sender, &chain, "G1RFD")?;
    let prepared = prepare(&mut sender, &chain, &refunded, true)?;
    let transaction = sign(&sender, &refunded, &prepared, true)?;
    ensure(
        chain.height()? < refunded.payment_box.refund_height,
        "test refund window already elapsed",
    )?;
    let early_refund = chain.verdict(&transaction)?;
    ensure(
        early_refund["allowed"] == false
            && early_refund["reject-reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("non-final")),
        "refund was not rejected as non-final",
    )?;
    chain.mine(refunded.payment_box.refund_height - chain.height()? + 1)?;
    ensure(
        chain.verdict(&transaction)?["allowed"] == true,
        "mature refund rejected by Bitcoin",
    )?;
    let refund = settle(
        &mut sender,
        &chain,
        &refunded,
        &prepared,
        &transaction,
        SUPPLY,
    )?;

    let report = json!({
        "status":"passed", "kind":"independent-native-capability-spike", "fork_commit":PIN,
        "network":"regtest", "internal_key":NUMS, "hash_algorithm":"SHA256", "secret_bytes":32,
        "scope":"RGB box lock/claim/refund and onward spend only; no loan, collateral E integration, G0 contract, mobile build or protocol-safety acceptance",
        "claim":{"asset_id":claimed.asset,"lock_outpoint":claimed.outpoint.to_string(),"amount":DEBT,"payment_hash":sha256::Hash::hash(&claimed.payment_box.secret).to_string(),"claim":claim,"onward":onward},
        "refund":{"asset_id":refunded.asset,"lock_outpoint":refunded.outpoint.to_string(),"refund_height":refunded.payment_box.refund_height,"refund":refund},
        "negative_checks":{"wrong_rgb_amount":"rejected by validate_htlc_spend","wrong_preimage":wrong_secret_verdict,"wrong_signature":wrong_signature_verdict,"attempted_keypath_bypass":keypath_verdict,"early_refund":early_refund},
        "duration_seconds":now()-started,
        "limitations":["An invalid keypath signature is rejected; NUMS safety relies on the standard discrete-log assumption, not this test.","Claim/refund/default/liquidation interleavings and unconfirmed-secret races remain G0 protocol work.","Native wallets were generated here; WDK-issued-asset compatibility is not proven."]
    });
    fs::write(
        data.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
