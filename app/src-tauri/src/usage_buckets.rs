//! Normalized, absolute UTC half-hour usage. Output includes reasoning; never add it twice.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Amounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
}
impl Amounts {
    pub fn total(self) -> Option<u64> {
        self.input
            .checked_add(self.output)?
            .checked_add(self.cache_read)?
            .checked_add(self.cache_write)
    }
    fn add(self, other: Self) -> Option<Self> {
        Some(Self {
            input: self.input.checked_add(other.input)?,
            output: self.output.checked_add(other.output)?,
            cache_read: self.cache_read.checked_add(other.cache_read)?,
            cache_write: self.cache_write.checked_add(other.cache_write)?,
            reasoning: self.reasoning.checked_add(other.reasoning)?,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub source: String,
    pub model: String,
    pub project_key: String,
    pub bucket_start: String,
    #[serde(flatten)]
    pub amounts: Amounts,
}
#[derive(Clone, Debug, Serialize)]
pub struct ModelAmounts {
    pub model: String,
    #[serde(flatten)]
    pub amounts: Amounts,
}
pub fn serialize_models<S: serde::Serializer>(
    value: &Accumulator,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value
        .model_amounts()
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}
#[derive(Clone, Default)]
pub struct Accumulator {
    rows: BTreeMap<(String, String, String, i64), Amounts>,
    invalid: bool,
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
impl Accumulator {
    pub fn record(
        &mut self,
        source: &str,
        model: &str,
        project: Option<&str>,
        timestamp: &str,
        amounts: Amounts,
    ) {
        if !self.try_record(source, model, project, timestamp, amounts) {
            self.invalid = true;
        }
    }
    fn try_record(
        &mut self,
        source: &str,
        model: &str,
        project: Option<&str>,
        timestamp: &str,
        amounts: Amounts,
    ) -> bool {
        let Ok(date) = chrono::DateTime::parse_from_rfc3339(timestamp) else {
            return false;
        };
        if source.is_empty()
            || source.len() > 40
            || model.is_empty()
            || model.len() > 200
            || amounts.reasoning > amounts.output
        {
            return false;
        }
        let Some(total) = amounts.total() else {
            return false;
        };
        if total == 0 {
            return true;
        }
        let start = date.timestamp().div_euclid(1800) * 1800;
        let key = (
            source.into(),
            model.into(),
            digest(project.unwrap_or("unknown").as_bytes()),
            start,
        );
        let prior = self.rows.get(&key).copied().unwrap_or_default();
        let Some(sum) = prior.add(amounts) else {
            return false;
        };
        if sum.total().is_none() {
            return false;
        }
        self.rows.insert(key, sum);
        true
    }
    pub fn model_amounts(&self) -> Result<Vec<ModelAmounts>, String> {
        if self.invalid {
            return Err("USAGE_NORMALIZATION_FAILED".into());
        }
        let mut models: BTreeMap<String, Amounts> = BTreeMap::new();
        for ((_, model, _, _), amounts) in &self.rows {
            let sum = models
                .get(model)
                .copied()
                .unwrap_or_default()
                .add(*amounts)
                .ok_or("USAGE_NORMALIZATION_FAILED")?;
            models.insert(model.clone(), sum);
        }
        Ok(models
            .into_iter()
            .map(|(model, amounts)| ModelAmounts { model, amounts })
            .collect())
    }
    pub fn export(&self, device: &str) -> Result<Vec<Bucket>, String> {
        if self.invalid {
            return Err("USAGE_NORMALIZATION_FAILED".into());
        }
        self.rows
            .iter()
            .map(|((source, model, project, start), amounts)| {
                let date =
                    chrono::DateTime::from_timestamp(*start, 0).ok_or("USAGE_TIME_INVALID")?;
                Ok(Bucket {
                    source: source.clone(),
                    model: model.clone(),
                    project_key: digest(format!("{device}:{project}").as_bytes()),
                    bucket_start: date.to_rfc3339(),
                    amounts: *amounts,
                })
            })
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn groups_offsets_into_utc_bucket_without_double_reasoning() {
        let mut a = Accumulator::default();
        let counts = Amounts {
            input: 20,
            output: 10,
            cache_read: 80,
            cache_write: 5,
            reasoning: 7,
        };
        a.record(
            "codex",
            "model",
            Some("/private/project"),
            "2026-11-03T18:03:00+08:00",
            counts,
        );
        a.record(
            "codex",
            "model",
            Some("/private/project"),
            "2026-11-03T10:29:59Z",
            counts,
        );
        let b = a.export("device-a").unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].amounts.total(), Some(230));
        assert_eq!(b[0].amounts.reasoning, 14);
        assert_eq!(b[0].bucket_start, "2026-11-03T10:00:00+00:00");
        assert!(!serde_json::to_string(&b).unwrap().contains("private"));
    }
    #[test]
    fn device_project_hashes_are_scoped_and_stable() {
        let mut a = Accumulator::default();
        a.record(
            "claude",
            "model",
            Some("/private"),
            "2026-11-03T10:00:00Z",
            Amounts {
                input: 1,
                ..Default::default()
            },
        );
        let one = a.export("one").unwrap();
        assert_eq!(one, a.export("one").unwrap());
        assert_ne!(one[0].project_key, a.export("two").unwrap()[0].project_key);
    }
    #[test]
    fn rejects_invalid_and_overflow_without_silent_clamp() {
        let mut a = Accumulator::default();
        a.record(
            "codex",
            "m",
            None,
            "2026-11-03T10:00:00Z",
            Amounts {
                input: u64::MAX,
                output: 1,
                ..Default::default()
            },
        );
        assert!(a.export("d").is_err());
        let mut b = Accumulator::default();
        b.record(
            "codex",
            "m",
            None,
            "2026-11-03T10:00:00Z",
            Amounts {
                output: 1,
                reasoning: 2,
                ..Default::default()
            },
        );
        assert!(b.export("d").is_err());
    }
    #[test]
    fn separates_models_and_projects() {
        let mut a = Accumulator::default();
        for (m, p) in [("m1", "p1"), ("m2", "p1"), ("m1", "p2")] {
            a.record(
                "codex",
                m,
                Some(p),
                "2026-11-03T10:00:00Z",
                Amounts {
                    input: 1,
                    ..Default::default()
                },
            );
        }
        assert_eq!(a.export("d").unwrap().len(), 3);
    }
}
