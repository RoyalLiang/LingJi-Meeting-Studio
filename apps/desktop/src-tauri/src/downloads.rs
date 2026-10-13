pub fn allowed(url: &url::Url, origin: &str) -> bool {
    match url.scheme() {
        "http" | "https" => url.origin().ascii_serialization() == origin,
        "blob" => url::Url::parse(url.path())
            .is_ok_and(|source| source.origin().ascii_serialization() == origin),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn downloads_require_the_exact_trusted_origin_even_for_blobs() {
        let origin = "http://127.0.0.1:55443";
        for value in [
            "http://127.0.0.1:55443/api/records/fixture/export",
            "blob:http://127.0.0.1:55443/64b26d24-f9ce-4371-bb76-fb57be838d1b",
        ] {
            assert!(allowed(&url::Url::parse(value).unwrap(), origin));
        }
        for value in [
            "http://127.0.0.1:55444/file",
            "https://127.0.0.1:55443/file",
            "http://127.0.0.1.attacker.invalid:55443/file",
            "blob:https://attacker.invalid/fixture",
            "blob:null/fixture",
            "data:text/html,fixture",
            "file:///tmp/fixture.html",
        ] {
            assert!(!allowed(&url::Url::parse(value).unwrap(), origin));
        }
    }
}
