//! Single-process wallet ownership and durable immutable operation facts.
//! This lock is held by the same process that owns rgb-lib's stash and database.
use rgb_lib::bitcoin::hashes::{Hash, sha256};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Independent of serde_json's additive preserve_order feature in other crates.
pub fn canonical_bytes(value: &Value) -> Result<Vec<u8>> {
    fn sort(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.sort_keys();
                for child in map.values_mut() {
                    sort(child);
                }
            }
            Value::Array(items) => {
                for child in items {
                    sort(child);
                }
            }
            _ => (),
        }
    }
    let mut copy = value.clone();
    sort(&mut copy);
    Ok(serde_json::to_vec(&copy)?)
}

pub struct Owner {
    root: PathBuf,
    _lock: File,
}
fn key(s: &str) -> Result<()> {
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("OWNER_INVALID_KEY".into());
    }
    Ok(())
}
fn hash(bytes: &[u8]) -> String {
    sha256::Hash::hash(bytes).to_string()
}
impl Owner {
    pub fn acquire(path: &Path) -> Result<Self> {
        fs::create_dir_all(path)?;
        let root = fs::canonicalize(path)?;
        #[cfg(unix)]
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600);
        let lock = options.open(root.join(".native-owner"))?;
        #[cfg(not(target_os = "android"))]
        lock.try_lock()
            .map_err(|e| format!("WALLET_ALREADY_OWNED_OR_LOCK_UNAVAILABLE: {e}"))?;
        // Rust std does not implement File::try_lock for Android. Use bionic's
        // nonblocking flock; the same File stays alive until this owner drops.
        #[cfg(target_os = "android")]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: File owns a valid descriptor throughout this syscall and
            // for the lifetime of Owner. No pointer or borrowed buffer is passed.
            let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                return Err(format!(
                    "WALLET_ALREADY_OWNED_OR_LOCK_UNAVAILABLE: {}",
                    std::io::Error::last_os_error()
                )
                .into());
            }
        }
        for name in ["slots", "artifacts", "exports", "observations", "effects"] {
            fs::create_dir_all(root.join(name))?;
        }
        File::open(&root)?.sync_all()?;
        Ok(Self { root, _lock: lock })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    // Atomic hard-link publication avoids a partially written create-new target.
    // Every published object is immutable. Orphan temp files are never read.
    fn publish(&self, target: &Path, bytes: &[u8]) -> Result<()> {
        if target.exists() {
            if fs::read(target)? != bytes {
                return Err("IMMUTABLE_OPERATION_CONFLICT".into());
            }
            return Ok(());
        }
        let temp = target.with_extension(format!("tmp-{}", std::process::id()));
        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);
        #[cfg(unix)]
        opts.mode(0o600);
        // A crashed predecessor may leave this PID-named file. Never overwrite it.
        let temp = if temp.exists() {
            target.with_extension(format!(
                "tmp-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
            ))
        } else {
            temp
        };
        let mut file = opts.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        match fs::hard_link(&temp, target) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if fs::read(target)? != bytes {
                    return Err("IMMUTABLE_OPERATION_CONFLICT".into());
                }
            }
            Err(e) => return Err(e.into()),
        }
        File::open(target.parent().ok_or("missing parent")?)?.sync_all()?;
        fs::remove_file(temp)?;
        Ok(())
    }
    pub fn put_artifact(&self, bytes: &[u8]) -> Result<String> {
        if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
            return Err("ARTIFACT_SIZE".into());
        }
        let digest = hash(bytes);
        self.publish(&self.root.join("artifacts").join(&digest), bytes)?;
        Ok(digest)
    }
    pub fn artifact(&self, digest: &str) -> Result<Vec<u8>> {
        key(digest)?;
        let bytes = fs::read(self.root.join("artifacts").join(digest))?;
        if hash(&bytes) != digest {
            return Err("ARTIFACT_CORRUPT".into());
        }
        Ok(bytes)
    }
    pub fn reserve(&self, slot: &str, intent_hash: &str, intent: Value) -> Result<Value> {
        key(slot)?;
        key(intent_hash)?;
        let value = json!({"slot":slot,"intent_hash":intent_hash,"intent":intent});
        self.publish(
            &self.root.join("slots").join(slot),
            &canonical_bytes(&value)?,
        )?;
        Ok(value)
    }
    pub fn slot(&self, slot: &str) -> Result<Value> {
        key(slot)?;
        Ok(serde_json::from_slice(&fs::read(
            self.root.join("slots").join(slot),
        )?)?)
    }
    /// Intent is committed before invoking a native side effect. Completion can be
    /// replayed; an unresolved intent must be reconciled, never invoked a second time.
    pub fn effect_intent(&self, slot: &str, stage: &str, payload: Value) -> Result<Value> {
        self.slot(slot)?;
        key(stage)?;
        let record = json!({"slot":slot,"stage":stage,"payload":payload});
        self.publish(
            &self
                .root
                .join("effects")
                .join(format!("{slot}-{stage}-intent")),
            &canonical_bytes(&record)?,
        )?;
        Ok(record)
    }
    pub fn effect_result(&self, slot: &str, stage: &str, result: Value) -> Result<Value> {
        key(slot)?;
        key(stage)?;
        if !self
            .root
            .join("effects")
            .join(format!("{slot}-{stage}-intent"))
            .is_file()
        {
            return Err("EFFECT_NOT_RESERVED".into());
        }
        self.publish(
            &self
                .root
                .join("effects")
                .join(format!("{slot}-{stage}-result")),
            &canonical_bytes(&result)?,
        )?;
        Ok(result)
    }
    pub fn effect(&self, slot: &str, stage: &str) -> Result<Value> {
        self.slot(slot)?;
        key(stage)?;
        let read = |suffix| -> Result<Value> {
            let p = self
                .root
                .join("effects")
                .join(format!("{slot}-{stage}-{suffix}"));
            Ok(if p.exists() {
                serde_json::from_slice(&fs::read(p)?)?
            } else {
                Value::Null
            })
        };
        Ok(json!({"intent":read("intent")?,"result":read("result")?}))
    }
    /// Persist actual signed bytes and authorization before returning any signature.
    /// Retrying a slot/stage can only return exactly the same exported transaction.
    pub fn export(
        &self,
        slot: &str,
        stage: &str,
        signed: &[u8],
        authority: Value,
    ) -> Result<Value> {
        self.slot(slot)?;
        key(stage)?;
        let digest = self.put_artifact(signed)?;
        let record = json!({"slot":slot,"stage":stage,"signed_artifact":digest,"authority":authority,"signatures_exported":true});
        self.publish(
            &self.root.join("exports").join(format!("{slot}-{stage}")),
            &canonical_bytes(&record)?,
        )?;
        Ok(record)
    }
    pub fn exported(&self, slot: &str, stage: &str) -> Result<Option<Value>> {
        self.slot(slot)?;
        key(stage)?;
        let path = self.root.join("exports").join(format!("{slot}-{stage}"));
        Ok(if path.exists() {
            Some(serde_json::from_slice(&fs::read(path)?)?)
        } else {
            None
        })
    }
    /// Chain observations are immutable history, not a monotone settlement flag.
    /// A later observation can report zero confirmations after a reorg.
    pub fn observe(&self, slot: &str, observation: Value) -> Result<String> {
        self.slot(slot)?;
        let bytes = canonical_bytes(&observation)?;
        let digest = hash(&bytes);
        self.publish(
            &self
                .root
                .join("observations")
                .join(format!("{slot}-{digest}")),
            &bytes,
        )?;
        Ok(digest)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "passbook-native-owner-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    #[test]
    fn exclusive_owner_is_released_on_exit() {
        let p = path();
        let a = Owner::acquire(&p).unwrap();
        assert!(Owner::acquire(&p).is_err());
        drop(a);
        assert!(Owner::acquire(&p).is_ok());
    }
    #[test]
    fn retries_conflict_and_export_survive_restart_and_reorg() {
        let p = path();
        let slot = "a".repeat(64);
        let stage = "b".repeat(64);
        let a = Owner::acquire(&p).unwrap();
        a.reserve(&slot, &stage, json!({"amount":"600"})).unwrap();
        a.reserve(&slot, &stage, json!({"amount":"600"})).unwrap();
        assert!(a.reserve(&slot, &stage, json!({"amount":"601"})).is_err());
        a.effect_intent(&slot, &stage, json!({"action":"prepare"}))
            .unwrap();
        assert!(a.effect(&slot, &stage).unwrap()["result"].is_null());
        a.effect_result(&slot, &stage, json!({"native_id":"op"}))
            .unwrap();
        let exported = a
            .export(&slot, &stage, b"signed bytes", json!({"gate":"approved"}))
            .unwrap();
        assert!(
            a.export(
                &slot,
                &stage,
                b"different bytes",
                json!({"gate":"approved"})
            )
            .is_err()
        );
        a.observe(&slot, json!({"confirmations":6,"block_hash":"old"}))
            .unwrap();
        drop(a);
        let b = Owner::acquire(&p).unwrap();
        b.observe(&slot, json!({"confirmations":0,"block_hash":null}))
            .unwrap();
        assert_eq!(b.exported(&slot, &stage).unwrap(), Some(exported));
        assert!(b.reserve(&slot, &stage, json!({"amount":"601"})).is_err());
        assert_eq!(
            b.effect(&slot, &stage).unwrap()["result"]["native_id"],
            "op"
        );
    }
    #[test]
    fn corrupted_artifacts_and_traversal_fail_closed() {
        let p = path();
        let a = Owner::acquire(&p).unwrap();
        assert!(a.slot("../escape").is_err());
        let digest = a.put_artifact(b"proof").unwrap();
        fs::write(p.join("artifacts").join(&digest), b"changed").unwrap();
        assert!(a.artifact(&digest).is_err());
    }
}
