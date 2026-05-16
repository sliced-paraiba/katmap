#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::companion::TrailAccumulator;
    use crate::history::{TrailEdits, apply_trail_edits};
    use crate::types::{BreadcrumbPoint, Waypoint};
    use crate::ws::{UndoStack, WaypointState, WaypointStore, remaining_waypoints_for_live_route};
    use std::sync::Arc;
    use tokio::sync::{RwLock, broadcast};
    use uuid::Uuid;

    fn point(timestamp_ms: i64, lon: f64, lat: f64) -> BreadcrumbPoint {
        BreadcrumbPoint {
            timestamp_ms,
            lon,
            lat,
            altitude: None,
            accuracy: None,
            altitude_accuracy: None,
            heading: None,
            speed: None,
        }
    }

    fn waypoint(label: &str, lat: f64, lon: f64) -> Waypoint {
        Waypoint {
            id: Uuid::new_v4(),
            lat,
            lon,
            label: label.to_string(),
            active: true,
        }
    }

    fn waypoint_store() -> (WaypointStore, WaypointState, UndoStack) {
        let waypoints = Arc::new(RwLock::new(Vec::new()));
        let undo_stack = Arc::new(RwLock::new(Vec::new()));
        let (tx, _) = broadcast::channel(16);
        (
            WaypointStore::new(waypoints.clone(), undo_stack.clone(), tx),
            waypoints,
            undo_stack,
        )
    }

    #[test]
    fn insert_sorted_reports_false_for_in_order_points() {
        let mut trail = TrailAccumulator::default();

        assert!(!trail.insert_sorted(point(1000, 1.0, 1.0)));
        assert!(!trail.insert_sorted(point(2000, 2.0, 2.0)));
        assert_eq!(trail.coords(), vec![[1.0, 1.0], [2.0, 2.0]]);
    }

    #[test]
    fn insert_sorted_reports_true_and_reorders_out_of_order_points() {
        let mut trail = TrailAccumulator::default();

        assert!(!trail.insert_sorted(point(1000, 1.0, 1.0)));
        assert!(!trail.insert_sorted(point(3000, 3.0, 3.0)));
        assert!(trail.insert_sorted(point(2000, 2.0, 2.0)));

        assert_eq!(
            trail
                .points
                .iter()
                .map(|p| p.timestamp_ms)
                .collect::<Vec<_>>(),
            vec![1000, 2000, 3000]
        );
        assert_eq!(trail.coords(), vec![[1.0, 1.0], [2.0, 2.0], [3.0, 3.0]]);
    }

    #[test]
    fn insert_sorted_treats_equal_timestamps_as_not_out_of_order() {
        let mut trail = TrailAccumulator::default();

        assert!(!trail.insert_sorted(point(1000, 1.0, 1.0)));
        assert!(!trail.insert_sorted(point(1000, 2.0, 2.0)));

        assert_eq!(trail.coords(), vec![[1.0, 1.0], [2.0, 2.0]]);
    }

    #[test]
    fn live_route_suffix_keeps_first_waypoint_before_route_start() {
        let waypoints = vec![
            waypoint("1", 47.0, -122.0),
            waypoint("2", 47.0, -121.99),
            waypoint("3", 47.0, -121.98),
        ];

        let remaining = remaining_waypoints_for_live_route(47.0, -122.002, &waypoints);

        assert_eq!(
            remaining
                .iter()
                .map(|w| w.label.as_str())
                .collect::<Vec<_>>(),
            vec!["1", "2", "3"]
        );
    }

    #[test]
    fn live_route_suffix_skips_passed_waypoints_on_current_segment() {
        let waypoints = vec![
            waypoint("1", 47.0, -122.0),
            waypoint("2", 47.0, -121.99),
            waypoint("3", 47.0, -121.98),
        ];

        let remaining = remaining_waypoints_for_live_route(47.0, -121.995, &waypoints);

        assert_eq!(
            remaining
                .iter()
                .map(|w| w.label.as_str())
                .collect::<Vec<_>>(),
            vec!["2", "3"]
        );
    }

    #[test]
    fn live_route_suffix_at_end_of_two_point_route_targets_only_end() {
        let waypoints = vec![waypoint("1", 47.0, -122.0), waypoint("2", 47.0, -121.99)];

        let remaining = remaining_waypoints_for_live_route(47.0, -121.99, &waypoints);

        assert_eq!(
            remaining
                .iter()
                .map(|w| w.label.as_str())
                .collect::<Vec<_>>(),
            vec!["2"]
        );
    }

    #[test]
    fn apply_trail_edits_returns_original_points_when_empty() {
        let points = [[1.0, 1.0], [2.0, 2.0], [3.0, 3.0]];
        let edits = TrailEdits::default();

        assert_eq!(apply_trail_edits(&points, &edits), points);
    }

    #[test]
    fn apply_trail_edits_hides_points() {
        let points = [[1.0, 1.0], [2.0, 2.0], [3.0, 3.0]];
        let edits = TrailEdits {
            hidden_indices: vec![1],
            moved_points: BTreeMap::new(),
            ..TrailEdits::default()
        };

        assert_eq!(
            apply_trail_edits(&points, &edits),
            vec![[1.0, 1.0], [3.0, 3.0]]
        );
    }

    #[test]
    fn apply_trail_edits_moves_points() {
        let points = [[1.0, 1.0], [2.0, 2.0], [3.0, 3.0]];
        let edits = TrailEdits {
            hidden_indices: vec![],
            moved_points: BTreeMap::from([(1, [20.0, 20.0])]),
            ..TrailEdits::default()
        };

        assert_eq!(
            apply_trail_edits(&points, &edits),
            vec![[1.0, 1.0], [20.0, 20.0], [3.0, 3.0]]
        );
    }

    #[test]
    fn apply_trail_edits_hide_wins_over_move_for_same_point() {
        let points = [[1.0, 1.0], [2.0, 2.0], [3.0, 3.0]];
        let edits = TrailEdits {
            hidden_indices: vec![1],
            moved_points: BTreeMap::from([(1, [20.0, 20.0])]),
            ..TrailEdits::default()
        };

        assert_eq!(
            apply_trail_edits(&points, &edits),
            vec![[1.0, 1.0], [3.0, 3.0]]
        );
    }

    #[test]
    fn apply_trail_edits_ignores_out_of_range_indices() {
        let points = [[1.0, 1.0], [2.0, 2.0]];
        let edits = TrailEdits {
            hidden_indices: vec![99],
            moved_points: BTreeMap::from([(42, [42.0, 42.0])]),
            ..TrailEdits::default()
        };

        assert_eq!(apply_trail_edits(&points, &edits), points);
    }

    #[tokio::test]
    async fn waypoint_store_add_then_undo_restores_empty_list() {
        let (store, waypoints, undo_stack) = waypoint_store();

        store.add(47.0, -122.0, "Stop 1".to_string()).await;
        assert_eq!(waypoints.read().await.len(), 1);
        assert_eq!(undo_stack.read().await.len(), 1);

        store.undo().await;
        assert!(waypoints.read().await.is_empty());
        assert!(undo_stack.read().await.is_empty());
    }

    #[tokio::test]
    async fn waypoint_store_rename_and_set_active_are_undoable() {
        let (store, waypoints, _) = waypoint_store();

        store.add(47.0, -122.0, "Stop 1".to_string()).await;
        let id = waypoints.read().await[0].id;

        store.rename(id, "Renamed".to_string()).await;
        assert_eq!(waypoints.read().await[0].label.as_str(), "Renamed");
        store.undo().await;
        assert_eq!(waypoints.read().await[0].label.as_str(), "Stop 1");

        store.set_active(id, false).await;
        assert!(!waypoints.read().await[0].active);
        store.undo().await;
        assert!(waypoints.read().await[0].active);
    }

    #[tokio::test]
    async fn waypoint_store_delete_all_empty_does_not_push_undo() {
        let (store, _, undo_stack) = waypoint_store();

        store.delete_all().await;

        assert!(undo_stack.read().await.is_empty());
    }

    #[tokio::test]
    async fn waypoint_store_reorder_appends_omitted_waypoints() {
        let (store, waypoints, _) = waypoint_store();

        store.add(47.0, -122.0, "A".to_string()).await;
        store.add(47.1, -122.1, "B".to_string()).await;
        store.add(47.2, -122.2, "C".to_string()).await;
        let ids = waypoints
            .read()
            .await
            .iter()
            .map(|w| w.id)
            .collect::<Vec<_>>();

        store.reorder(vec![ids[2], ids[0]]).await;

        assert_eq!(
            waypoints
                .read()
                .await
                .iter()
                .map(|w| w.label.as_str().to_string())
                .collect::<Vec<_>>(),
            vec!["C", "A", "B"]
        );
    }
}
