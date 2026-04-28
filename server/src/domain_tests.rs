#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::companion::TrailAccumulator;
    use crate::history::{TrailEdits, apply_trail_edits};
    use crate::types::BreadcrumbPoint;

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
        };

        assert_eq!(apply_trail_edits(&points, &edits), points);
    }
}
