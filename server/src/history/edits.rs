use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrailEdits {
    /// Original breadcrumb indices hidden from display. Non-destructive: original points stay in DB.
    #[serde(default)]
    pub hidden_indices: Vec<usize>,
    /// Original breadcrumb index -> replacement `[lon, lat]`.
    #[serde(default)]
    pub moved_points: BTreeMap<usize, [f64; 2]>,
    /// Last admin edit timestamp, milliseconds since Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    /// Best-effort editor identity. With shared-token auth this is intentionally coarse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

pub(crate) fn parse_edits(json: Option<&str>) -> TrailEdits {
    json.and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default()
}

pub(crate) fn apply_trail_edits(points: &[[f64; 2]], edits: &TrailEdits) -> Vec<[f64; 2]> {
    points
        .iter()
        .enumerate()
        .filter_map(|(idx, point)| {
            if edits.hidden_indices.contains(&idx) {
                None
            } else {
                Some(edits.moved_points.get(&idx).copied().unwrap_or(*point))
            }
        })
        .collect()
}
