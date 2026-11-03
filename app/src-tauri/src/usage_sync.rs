//! Durable incremental outbox. An ambiguous network result never advances the local acknowledgement.
use crate::usage_buckets::{digest, Bucket};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::Path};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub device_id: String,
    pub batch_id: String,
    pub sequence: u64,
    pub client_version: String,
    pub buckets: Vec<Bucket>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<serde_json::Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Pending {
    batch: Batch,
    updates: BTreeMap<String, String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct State {
    version: u8,
    next_sequence: u64,
    hashes: BTreeMap<String, String>,
    pending: Option<Pending>,
    #[serde(default)]
    last_receipt_hash: Option<String>,
    #[serde(default)]
    last_profile_hash: Option<String>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            next_sequence: 1,
            hashes: BTreeMap::new(),
            pending: None,
            last_receipt_hash: None,
            last_profile_hash: None,
        }
    }
}
fn identity(bucket: &Bucket) -> Result<String, String> {
    serde_json::to_vec(&(
        &bucket.source,
        &bucket.model,
        &bucket.project_key,
        &bucket.bucket_start,
    ))
    .map(|b| digest(&b))
    .map_err(|_| "SYNC_ENCODE_FAILED".into())
}
impl State {
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(path).map_err(|_| "SYNC_STATE_UNREADABLE")?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("SYNC_STATE_TOO_LARGE".into());
        }
        let state: Self = serde_json::from_slice(&bytes).map_err(|_| "SYNC_STATE_INVALID")?;
        if state.version != 1
            || state.next_sequence == 0
            || state.next_sequence > 9_007_199_254_740_991
        {
            return Err("SYNC_STATE_INVALID".into());
        }
        Ok(state)
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let parent = path.parent().ok_or("SYNC_STATE_PATH_INVALID")?;
        fs::create_dir_all(parent).map_err(|_| "SYNC_STATE_UNWRITABLE")?;
        let temp = parent.join(format!(".usage-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<(), std::io::Error> {
            let mut file = options.open(&temp)?;
            file.write_all(&serde_json::to_vec(self)?)?;
            file.sync_all()?;
            fs::rename(&temp, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result.map_err(|_| "SYNC_STATE_UNWRITABLE".into())
    }
    pub fn align_sequence(&mut self, last_accepted: u64) -> Result<(), String> {
        if last_accepted >= 9_007_199_254_740_991 {
            return Err("SYNC_SEQUENCE_EXHAUSTED".into());
        }
        // Never rewrite an in-flight batch: the server may already have accepted this exact ID.
        if self.pending.is_none() {
            self.next_sequence = self.next_sequence.max(last_accepted + 1);
        }
        Ok(())
    }
    pub fn pending_batch(&self) -> Option<Batch> {
        self.pending.as_ref().map(|pending| pending.batch.clone())
    }
    #[cfg(test)]
    pub fn prepare(
        &mut self,
        device: &str,
        version: &str,
        buckets: &[Bucket],
        receipt: Option<serde_json::Value>,
    ) -> Result<Option<Batch>, String> {
        self.prepare_with_profile(device, version, buckets, receipt, None)
    }
    pub fn prepare_with_profile(
        &mut self,
        device: &str,
        version: &str,
        buckets: &[Bucket],
        receipt: Option<serde_json::Value>,
        profile: Option<serde_json::Value>,
    ) -> Result<Option<Batch>, String> {
        if let Some(pending) = &self.pending {
            return Ok(Some(pending.batch.clone()));
        }
        let mut selected = Vec::new();
        let mut updates = BTreeMap::new();
        let profile_bytes = profile
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| "SYNC_ENCODE_FAILED")?;
        if profile_bytes
            .as_ref()
            .is_some_and(|bytes| bytes.len() > 64 * 1024)
        {
            return Err("SYNC_PROFILE_TOO_LARGE".into());
        }
        let profile_hash = profile_bytes.as_ref().map(|bytes| digest(bytes));
        let mut size = 256 + profile_bytes.as_ref().map_or(0, Vec::len);
        for bucket in buckets {
            let bytes = serde_json::to_vec(bucket).map_err(|_| "SYNC_ENCODE_FAILED")?;
            let key = identity(bucket)?;
            let hash = digest(&bytes);
            if self.hashes.get(&key) == Some(&hash) {
                continue;
            }
            if !selected.is_empty() && (selected.len() >= 512 || size + bytes.len() > 450 * 1024) {
                break;
            }
            if bytes.len() > 450 * 1024 {
                return Err("SYNC_BUCKET_TOO_LARGE".into());
            }
            size += bytes.len();
            updates.insert(key, hash);
            selected.push(bucket.clone());
        }
        let receipt_hash = receipt
            .as_ref()
            .map(|v| serde_json::to_vec(v).map(|b| digest(&b)))
            .transpose()
            .map_err(|_| "SYNC_ENCODE_FAILED")?;
        if selected.is_empty()
            && receipt_hash == self.last_receipt_hash
            && profile_hash == self.last_profile_hash
        {
            return Ok(None);
        }
        let batch = Batch {
            device_id: device.into(),
            batch_id: uuid::Uuid::new_v4().to_string(),
            sequence: self.next_sequence,
            client_version: version.into(),
            buckets: selected,
            receipt,
            profile,
        };
        self.pending = Some(Pending {
            batch: batch.clone(),
            updates,
        });
        Ok(Some(batch))
    }
    pub fn receipt_policy(&mut self, enabled: bool, last_accepted: u64) -> Result<(), String> {
        if enabled {
            return Ok(());
        }
        if let Some(pending) = &mut self.pending {
            if pending.batch.receipt.is_some() {
                pending.batch.receipt = None;
                pending.batch.batch_id = uuid::Uuid::new_v4().to_string();
                pending.batch.sequence = pending.batch.sequence.max(
                    last_accepted
                        .checked_add(1)
                        .ok_or("SYNC_SEQUENCE_EXHAUSTED")?,
                );
            }
        }
        Ok(())
    }
    pub fn reject_stale(&mut self, last_accepted: u64) -> Result<(), String> {
        // A known rejection is not an acknowledgement. Recollect source logs on the next attempt.
        self.pending = None;
        self.align_sequence(last_accepted)
    }
    pub fn prune(&mut self, buckets: &[Bucket]) -> Result<(), String> {
        let mut live = std::collections::BTreeSet::new();
        for bucket in buckets {
            live.insert(identity(bucket)?);
        }
        if let Some(pending) = &self.pending {
            live.extend(pending.updates.keys().cloned());
        }
        self.hashes.retain(|key, _| live.contains(key));
        Ok(())
    }
    pub fn acknowledge(&mut self, batch_id: &str) -> Result<(), String> {
        let pending = self.pending.as_ref().ok_or("SYNC_NO_PENDING_BATCH")?;
        if pending.batch.batch_id != batch_id {
            return Err("SYNC_RECEIPT_MISMATCH".into());
        }
        let next = pending
            .batch
            .sequence
            .checked_add(1)
            .filter(|x| *x <= 9_007_199_254_740_991)
            .ok_or("SYNC_SEQUENCE_EXHAUSTED")?;
        let pending = self.pending.take().unwrap();
        self.last_receipt_hash = pending
            .batch
            .receipt
            .as_ref()
            .map(|v| serde_json::to_vec(v).map(|b| digest(&b)))
            .transpose()
            .map_err(|_| "SYNC_ENCODE_FAILED")?;
        self.last_profile_hash = pending
            .batch
            .profile
            .as_ref()
            .map(|v| serde_json::to_vec(v).map(|b| digest(&b)))
            .transpose()
            .map_err(|_| "SYNC_ENCODE_FAILED")?;
        self.hashes.extend(pending.updates);
        self.next_sequence = next;
        Ok(())
    }
}
pub fn device_id(root: &Path) -> Result<String, String> {
    fs::create_dir_all(root).map_err(|_| "DEVICE_STATE_UNWRITABLE")?;
    let path = root.join("device-id");
    if !path.exists() {
        let id = uuid::Uuid::new_v4().to_string();
        let temporary = root.join(format!(".device-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<(), std::io::Error> {
            let mut file = options.open(&temporary)?;
            file.write_all(id.as_bytes())?;
            file.sync_all()?;
            match fs::hard_link(&temporary, &path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                Err(e) => Err(e),
            }
        })();
        let _ = fs::remove_file(temporary);
        result.map_err(|_| "DEVICE_STATE_UNWRITABLE")?;
    }
    let id = fs::read_to_string(path).map_err(|_| "DEVICE_STATE_UNREADABLE")?;
    uuid::Uuid::parse_str(id.trim())
        .map(|id| id.to_string())
        .map_err(|_| "DEVICE_STATE_INVALID".into())
}

pub fn state_path(root: &Path, origin: &str, user: &str, device: &str) -> std::path::PathBuf {
    root.join(format!(
        "{}.json",
        digest(format!("{origin}:{user}:{device}").as_bytes())
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_buckets::Amounts;
    fn bucket(n: u64) -> Bucket {
        Bucket {
            source: "codex".into(),
            model: "fixture".into(),
            project_key: "0123456789abcdef".into(),
            bucket_start: "2026-11-03T10:00:00Z".into(),
            amounts: Amounts {
                input: n,
                ..Default::default()
            },
        }
    }
    #[test]
    fn keeps_identical_pending_until_explicit_ack() {
        let mut state = State::default();
        let first = state
            .prepare("d", "v", &[bucket(10)], None)
            .unwrap()
            .unwrap();
        assert_eq!(
            Some(first.clone()),
            state.prepare("d", "v", &[bucket(20)], None).unwrap()
        );
        assert!(state.acknowledge("wrong").is_err());
        state.acknowledge(&first.batch_id).unwrap();
        let next = state
            .prepare("d", "v", &[bucket(20)], None)
            .unwrap()
            .unwrap();
        assert_eq!(next.sequence, 2);
        assert_ne!(next.batch_id, first.batch_id);
    }
    #[test]
    fn unchanged_bucket_sends_nothing_and_deletion_does_not_delete_cloud() {
        let mut s = State::default();
        let b = s.prepare("d", "v", &[bucket(10)], None).unwrap().unwrap();
        s.acknowledge(&b.batch_id).unwrap();
        assert!(s.prepare("d", "v", &[bucket(10)], None).unwrap().is_none());
        assert!(s.prepare("d", "v", &[], None).unwrap().is_none());
        assert_eq!(s.hashes.len(), 1);
    }
    #[test]
    fn persists_pending_before_delivery_and_recovers_after_restart() {
        let root = std::env::temp_dir().join(format!("haki-outbox-{}", uuid::Uuid::new_v4()));
        let file = root.join("state.json");
        let mut s = State::default();
        let b = s.prepare("d", "v", &[bucket(10)], None).unwrap().unwrap();
        s.save(&file).unwrap();
        let mut recovered = State::load(&file).unwrap();
        assert_eq!(
            Some(b.clone()),
            recovered.prepare("d", "v", &[], None).unwrap()
        );
        recovered.acknowledge(&b.batch_id).unwrap();
        recovered.save(&file).unwrap();
        assert!(State::load(&file)
            .unwrap()
            .prepare("d", "v", &[bucket(10)], None)
            .unwrap()
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sequence_recovery_preserves_in_flight_identity() {
        let mut s = State::default();
        s.align_sequence(9).unwrap();
        let b = s.prepare("d", "v", &[bucket(1)], None).unwrap().unwrap();
        assert_eq!(b.sequence, 10);
        s.align_sequence(20).unwrap();
        assert_eq!(s.prepare("d", "v", &[], None).unwrap().unwrap(), b);
    }
    #[test]
    fn scopes_state_to_origin_user_and_device() {
        let p = Path::new("/fixture");
        assert_ne!(
            state_path(p, "cn", "u1", "d"),
            state_path(p, "cn", "u2", "d")
        );
        assert_ne!(
            state_path(p, "cn", "u1", "d"),
            state_path(p, "space", "u1", "d")
        );
        assert_ne!(
            state_path(p, "cn", "u1", "d"),
            state_path(p, "cn", "u1", "d2")
        );
    }
    #[test]
    fn receipt_changes_sync_even_when_usage_is_unchanged() {
        let mut s = State::default();
        let receipt = serde_json::json!({"providers":[],"clis":["codex"]});
        let first = s
            .prepare("d", "v", &[], Some(receipt.clone()))
            .unwrap()
            .unwrap();
        assert!(first.buckets.is_empty());
        assert_eq!(s.pending_batch(), Some(first.clone()));
        s.acknowledge(&first.batch_id).unwrap();
        assert!(s.pending_batch().is_none());
        assert!(s.prepare("d", "v", &[], Some(receipt)).unwrap().is_none());
        let withdrawal = s.prepare("d", "v", &[], None).unwrap().unwrap();
        assert!(withdrawal.receipt.is_none());
    }
    #[test]
    fn profile_only_changes_are_durable_without_repeating_token_buckets() {
        let mut s = State::default();
        let profile = serde_json::json!({"periodDays":30,"skills":[{"name":"fixture","count":1}],"projects":[]});
        let first = s
            .prepare_with_profile("d", "v", &[bucket(10)], None, Some(profile.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(first.profile, Some(profile.clone()));
        s.acknowledge(&first.batch_id).unwrap();
        assert!(s
            .prepare_with_profile("d", "v", &[bucket(10)], None, Some(profile.clone()))
            .unwrap()
            .is_none());
        let mut changed = profile.clone();
        changed["skills"][0]["count"] = serde_json::json!(2);
        let next = s
            .prepare_with_profile("d", "v", &[bucket(10)], None, Some(changed.clone()))
            .unwrap()
            .unwrap();
        assert!(next.buckets.is_empty());
        assert_eq!(next.profile, Some(changed));
        assert_ne!(next.batch_id, first.batch_id);
        assert_eq!(
            s.prepare_with_profile("d", "v", &[], None, Some(profile))
                .unwrap(),
            Some(next)
        );
    }
    #[test]
    fn withdrawal_redacts_pending_receipt_without_reusing_batch_identity() {
        let mut s = State::default();
        let batch = s
            .prepare(
                "d",
                "v",
                &[bucket(10)],
                Some(serde_json::json!({"providers":[],"clis":[]})),
            )
            .unwrap()
            .unwrap();
        s.receipt_policy(false, batch.sequence).unwrap();
        let retry = s.prepare("d", "v", &[], None).unwrap().unwrap();
        assert!(retry.receipt.is_none());
        assert_ne!(retry.batch_id, batch.batch_id);
        assert!(retry.sequence > batch.sequence);
    }
    #[test]
    fn rejected_stale_does_not_ack_and_pruning_never_discards_pending() {
        let mut s = State::default();
        let first = s.prepare("d", "v", &[bucket(10)], None).unwrap().unwrap();
        s.prune(&[]).unwrap();
        assert_eq!(s.prepare("d", "v", &[], None).unwrap().unwrap(), first);
        s.reject_stale(20).unwrap();
        assert!(s.hashes.is_empty());
        let fresh = s.prepare("d", "v", &[bucket(20)], None).unwrap().unwrap();
        assert_eq!(fresh.sequence, 21);
        assert_ne!(fresh.batch_id, first.batch_id);
    }
    #[test]
    fn device_identifier_is_stable_without_credentials() {
        let dir = std::env::temp_dir().join(format!("haki-device-{}", uuid::Uuid::new_v4()));
        let id = device_id(&dir).unwrap();
        assert_eq!(id, device_id(&dir).unwrap());
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn chunks_large_uploads() {
        let mut s = State::default();
        let buckets: Vec<_> = (0..600)
            .map(|i| {
                let mut b = bucket(1);
                b.model = format!("m{i}");
                b
            })
            .collect();
        let first = s.prepare("d", "v", &buckets, None).unwrap().unwrap();
        assert_eq!(first.buckets.len(), 512);
        assert!(serde_json::to_vec(&first).unwrap().len() < 512 * 1024);
        s.acknowledge(&first.batch_id).unwrap();
        assert_eq!(
            s.prepare("d", "v", &buckets, None)
                .unwrap()
                .unwrap()
                .buckets
                .len(),
            88
        );
    }
}
