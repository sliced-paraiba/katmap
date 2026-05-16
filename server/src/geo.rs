pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::haversine_m;

    #[test]
    fn haversine_is_zero_for_same_point() {
        assert_eq!(haversine_m(47.6062, -122.3321, 47.6062, -122.3321), 0.0);
    }

    #[test]
    fn haversine_estimates_known_city_distance() {
        let seattle_to_portland_m = haversine_m(47.6062, -122.3321, 45.5152, -122.6784);
        assert!((seattle_to_portland_m - 233_000.0).abs() < 2_000.0);
    }
}
