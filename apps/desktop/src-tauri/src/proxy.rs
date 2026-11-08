use axum::{
    body::Body,
    extract::State,
    http::{header, Request, Response, StatusCode},
    Router,
};
use std::sync::Arc;
use subtle::ConstantTimeEq;

pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; frame-src 'none'; child-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
type AssetLoader = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;
#[derive(Clone)]
pub struct Proxy {
    client: reqwest::Client,
    upstream: String,
    origin: String,
    assets: AssetLoader,
    secret: String,
    cookie_name: String,
}

fn error(status: StatusCode, code: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(format!("{{\"error\":\"{code}\"}}")))
        .unwrap()
}

fn hop_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "cookie"
            | "set-cookie"
            | "forwarded"
    ) || name.starts_with("x-forwarded-")
}

async fn native_json_response(mut response: reqwest::Response) -> Result<serde_json::Value, String> {
            if !response.status().is_success() { return Err("原生音频连接未获授权，请重新打开会议后重试".into()); }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "本机音频服务未响应")? {
                if bytes.len() + chunk.len() > 524288 { return Err("本机音频服务响应超过限制".into()); }
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&bytes).map_err(|_| "本机音频服务响应无效".into())
        }

impl Proxy {
    pub async fn native_bind(&self, instance: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let bootstrap = native_json_response(self.client.get(format!("{}/api/bootstrap", self.upstream))
            .timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| "本机服务未就绪")?).await?;
        let csrf = bootstrap.get("csrf").and_then(|value| value.as_str()).ok_or("本机音频连接未获授权")?;
        native_json_response(self.client.post(format!("{}/api/client/native-captures", self.upstream))
            .header("Content-Type", "application/json").header("X-CSRF-Token", csrf).header("X-Native-Instance", instance)
            .body(serde_json::to_vec(&body).map_err(|_| "音源参数无效")?)
            .timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_| "本机音频服务未响应")?).await
    }
    #[cfg(feature = "smoke-test")]
    pub async fn evolution_probe_request(&self, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        if let Some(body) = body {
            let bootstrap=native_json_response(self.client.get(format!("{}/api/bootstrap",self.upstream)).send().await.map_err(|_|"本机测试服务不可用")?).await?;
            let csrf=bootstrap["csrf"].as_str().ok_or("本机测试授权不可用")?;
            native_json_response(self.client.post(format!("{}{path}",self.upstream)).header("Content-Type","application/json").header("X-CSRF-Token",csrf)
                .body(body.to_string()).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_|"本机测试服务不可用")?).await
        } else { native_json_response(self.client.get(format!("{}{path}",self.upstream)).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|_|"本机测试服务不可用")?).await }
    }
    #[cfg(test)]
    pub fn new(
        upstream: String,
        origin: String,
        assets: AssetLoader,
    ) -> Result<Self, reqwest::Error> {
        Self::new_with_session(upstream, origin, assets, None)
    }
    pub fn new_with_session(
        upstream: String,
        origin: String,
        assets: AssetLoader,
        session: Option<&str>,
    ) -> Result<Self, reqwest::Error> {
        let jar = Arc::new(reqwest::cookie::Jar::default());
        if let Some(cookie) = session {
            jar.add_cookie_str(
                cookie,
                &url::Url::parse(&upstream).expect("validated backend origin"),
            );
        }
        // Authentication cookies stay in this upstream's memory jar. They never become localhost cookies.
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).expect("OS random source");
        let cookie_name = format!(
            "tts_client_{}",
            url::Url::parse(&origin).unwrap().port().unwrap()
        );
        Ok(Self {
            client: reqwest::Client::builder()
                .cookie_provider(jar)
                .connect_timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            upstream,
            origin,
            assets,
            secret: secret.iter().map(|byte| format!("{byte:02x}")).collect(),
            cookie_name,
        })
    }
    pub fn startup_url(&self) -> String {
        format!("{}/?clientKey={}", self.origin, self.secret)
    }
    pub fn router(self) -> Router {
        Router::new().fallback(handle).with_state(self)
    }
    pub async fn update_barrier(&self) -> Result<(), String> {
        let request = self
            .client
            .get(format!("{}/api/client/update-barrier", self.upstream))
            .timeout(std::time::Duration::from_secs(10));
        let response = request
            .send()
            .await
            .map_err(|_| "无法核对服务端音频状态，暂不安装更新")?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err("请重新登录后安装更新".into());
        }
        if !response.status().is_success() {
            return Err("服务端安全更新接口不可用，请先更新后端并重试".into());
        }
        if response.content_length().is_some_and(|n| n > 524_288) {
            return Err("服务端安全状态超过限制".into());
        }
        let mut response = response;
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "服务端安全状态读取失败")?
        {
            if data.len() + chunk.len() > 524_288 {
                return Err("服务端安全状态超过限制".into());
            }
            data.extend(chunk);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&data).map_err(|_| "服务端安全状态格式无效")?;
        if value["protocol"] != 1 {
            return Err("服务端安全更新协议不兼容".into());
        }
        let records = value["records"].as_array().ok_or("服务端安全状态不完整")?;
        if records.len() > 200 {
            return Err("服务端会议数量超过检查限制".into());
        }
        for record in records {
            crate::update_gate::server_record_safe(record)?;
        }
        Ok(())
    }
}

async fn handle(State(proxy): State<Proxy>, request: Request<Body>) -> Response<Body> {
    let expected_host = proxy.origin.strip_prefix("http://").unwrap();
    if request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        != Some(expected_host)
    {
        return error(StatusCode::FORBIDDEN, "invalid_host");
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(proxy.origin.as_str()) {
            return error(StatusCode::FORBIDDEN, "invalid_origin");
        }
    }
    if request.method() == "GET"
        && request.uri().path() == "/"
        && request.uri().query() == Some(format!("clientKey={}", proxy.secret).as_str())
    {
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::LOCATION, "/")
            .header(
                header::SET_COOKIE,
                format!(
                    "{}={}; HttpOnly; SameSite=Strict; Path=/",
                    proxy.cookie_name, proxy.secret
                ),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .header("Referrer-Policy", "no-referrer")
            .body(Body::empty())
            .unwrap();
    }
    let prefix = format!("{}=", proxy.cookie_name);
    let authenticated = request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(';')
                .map(str::trim)
                .find_map(|cookie| cookie.strip_prefix(&prefix))
        })
        .is_some_and(|value| bool::from(value.as_bytes().ct_eq(proxy.secret.as_bytes())));
    if !authenticated {
        return error(StatusCode::FORBIDDEN, "client_session_required");
    }
    let path = request.uri().path();
    if path.starts_with("/api/") {
        if !matches!(request.method().as_str(), "GET" | "HEAD")
            && request.headers().get(header::ORIGIN).is_none()
        {
            return error(StatusCode::FORBIDDEN, "origin_required");
        }
        let upstream_url = format!("{}{}", proxy.upstream, request.uri());
        let (parts, body) = request.into_parts();
        let mut outgoing = proxy.client.request(parts.method, upstream_url);
        for (name, value) in &parts.headers {
            if !hop_header(name.as_str()) && name != header::ORIGIN && name != header::REFERER {
                outgoing = outgoing.header(name, value);
            }
        }
        // Validate the WebView origin above, then use the configured upstream authority.
        // This preserves HTTPS virtual-host routing and the Record API's public-origin CSRF policy.
        if parts.headers.contains_key(header::ORIGIN) {
            outgoing = outgoing.header(header::ORIGIN, &proxy.upstream);
        }
        outgoing = outgoing.body(reqwest::Body::wrap_stream(body.into_data_stream()));
        let upstream = match outgoing.send().await {
            Ok(r) => r,
            Err(_) => return error(StatusCode::BAD_GATEWAY, "service_unavailable"),
        };
        if upstream.status().is_redirection() {
            return error(StatusCode::BAD_GATEWAY, "upstream_redirect_rejected");
        }
        let mut response = Response::builder().status(upstream.status());
        for (name, value) in upstream.headers() {
            if !hop_header(name.as_str()) {
                response = response.header(name, value);
            }
        }
        return response
            .body(Body::from_stream(upstream.bytes_stream()))
            .unwrap();
    }
    if !matches!(request.method().as_str(), "GET" | "HEAD") {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    let asset = (proxy.assets)(path).or_else(|| {
        if !path.contains('.') {
            (proxy.assets)("/index.html")
        } else {
            None
        }
    });
    match asset {
        Some((bytes, mime)) => Response::builder()
            .header(header::CONTENT_TYPE, mime)
            .header("Content-Security-Policy", CSP)
            .header("X-Content-Type-Options", "nosniff")
            .header("Referrer-Policy", "no-referrer")
            .header(
                "Permissions-Policy",
                "camera=(), microphone=(self), display-capture=(self)",
            )
            .header(header::CACHE_CONTROL, "no-cache")
            .body(if request.method() == "HEAD" {
                Body::empty()
            } else {
                Body::from(bytes)
            })
            .unwrap(),
        None => error(StatusCode::NOT_FOUND, "not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::any;
    use futures_util::stream;

    async fn fixture(request: Request<Body>) -> Response<Body> {
        match request.uri().path() {
            "/api/authority" => Response::new(Body::from(format!(
                "{}|{}",
                request.headers()[header::HOST].to_str().unwrap(),
                request.headers()[header::ORIGIN].to_str().unwrap()
            ))),
            "/api/login" => Response::builder()
                .header(
                    header::SET_COOKIE,
                    "upstream_session=fixture; Path=/; HttpOnly; SameSite=Lax",
                )
                .body(Body::from("{\"csrf\":\"fixture-token\"}"))
                .unwrap(),
            "/api/logout" => Response::builder()
                .header(header::SET_COOKIE, "upstream_session=; Max-Age=0; Path=/")
                .body(Body::empty())
                .unwrap(),
            "/api/private" => {
                let cookie = request
                    .headers()
                    .get(header::COOKIE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                assert!(!cookie.contains("tts_client_"));
                if cookie.contains("upstream_session=fixture") {
                    Response::new(Body::from("authorized"))
                } else {
                    error(StatusCode::UNAUTHORIZED, "login_required")
                }
            }
            "/api/redirect" => Response::builder()
                .status(StatusCode::FOUND)
                .header(header::LOCATION, "https://example.invalid/")
                .body(Body::empty())
                .unwrap(),
            "/api/upload" => {
                assert_eq!(
                    request.headers().get("x-csrf-token").unwrap(),
                    "fixture-token"
                );
                let bytes = axum::body::to_bytes(request.into_body(), 100_000)
                    .await
                    .unwrap();
                Response::new(Body::from(bytes.len().to_string()))
            }
            "/api/events" => {
                let events = stream::unfold(0, |n| async move {
                    if n > 1 {
                        return None;
                    }
                    if n == 1 {
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                    Some((
                        Ok::<_, std::convert::Infallible>(
                            axum::response::sse::Event::default()
                                .id(n.to_string())
                                .data("fixture"),
                        ),
                        n + 1,
                    ))
                });
                use axum::response::IntoResponse;
                axum::response::Sse::new(events).into_response()
            }
            _ => error(StatusCode::NOT_FOUND, "not_found"),
        }
    }

    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (origin, task)
    }

    #[tokio::test]
    async fn proxy_guards_local_session_keeps_auth_private_and_streams() {
        let (upstream, upstream_task) = serve(Router::new().fallback(any(fixture))).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let proxy = Proxy::new(
            upstream.clone(),
            origin.clone(),
            Arc::new(|_| Some((b"fixture".to_vec(), "text/html".into()))),
        )
        .unwrap();
        let startup = proxy.startup_url();
        let task = tokio::spawn(async move {
            axum::serve(listener, proxy.router()).await.unwrap();
        });
        let browser = reqwest::Client::builder()
            .cookie_store(true)
            .no_proxy()
            .build()
            .unwrap();
        assert_eq!(
            browser.get(&origin).send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let response = browser.get(startup).send().await.unwrap();
        assert!(response.status().is_success());
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-src 'none'"));
        assert_eq!(
            browser
                .get(format!("{origin}/api/private"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let login = browser
            .post(format!("{origin}/api/login"))
            .header(header::ORIGIN, &origin)
            .send()
            .await
            .unwrap();
        assert!(login.headers().get(header::SET_COOKIE).is_none());
        assert_eq!(
            browser
                .post(format!("{origin}/api/authority"))
                .header(header::ORIGIN, &origin)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            format!("{}|{}", upstream.strip_prefix("http://").unwrap(), upstream)
        );
        assert_eq!(
            browser
                .get(format!("{origin}/api/private"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "authorized"
        );
        assert_eq!(
            browser
                .post(format!("{origin}/api/upload"))
                .header(header::ORIGIN, &origin)
                .header("x-csrf-token", "fixture-token")
                .body(vec![7u8; 96_000])
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "96000"
        );
        assert_eq!(
            browser
                .get(&origin)
                .header(header::HOST, "evil.test")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            browser
                .post(format!("{origin}/api/login"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            browser
                .get(&origin)
                .header(header::ORIGIN, "null")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            browser
                .get(format!("{origin}/api/redirect"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_GATEWAY
        );
        let start = std::time::Instant::now();
        let mut sse = browser
            .get(format!("{origin}/api/events"))
            .send()
            .await
            .unwrap();
        assert!(sse.chunk().await.unwrap().is_some());
        assert!(start.elapsed() < std::time::Duration::from_millis(200));
        assert!(sse.text().await.unwrap().contains("id: 1"));
        let other_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let other_origin = format!("http://{}", other_listener.local_addr().unwrap());
        let fresh = Proxy::new(
            upstream,
            other_origin.clone(),
            Arc::new(|_| Some((Vec::new(), "text/html".into()))),
        )
        .unwrap();
        let fresh_startup = fresh.startup_url();
        let fresh_task = tokio::spawn(async move {
            axum::serve(other_listener, fresh.router()).await.unwrap();
        });
        // Same browser cookie jar, different native upstream session: no authentication leaks across ports.
        browser.get(fresh_startup).send().await.unwrap();
        assert_eq!(
            browser
                .get(format!("{other_origin}/api/private"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            browser
                .get(format!("{origin}/api/private"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "authorized"
        );
        browser
            .post(format!("{origin}/api/logout"))
            .header(header::ORIGIN, &origin)
            .send()
            .await
            .unwrap();
        assert_eq!(
            browser
                .get(format!("{origin}/api/private"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        fresh_task.abort();
        task.abort();
        upstream_task.abort();
    }
}

// Authentication can redirect before the first page finishes, including during native recording recovery.
pub fn allow_main_navigation(url: &url::Url, origin: &str, loaded: bool, active: bool) -> bool {
    url.origin().ascii_serialization() == origin && (!loaded || !active)
}

#[cfg(test)]
#[test]
fn initial_same_origin_redirects_finish_before_recording_navigation_is_locked() {
    let origin="http://127.0.0.1:3030";
    let startup=url::Url::parse("http://127.0.0.1:3030/?clientKey=synthetic").unwrap();
    let home=url::Url::parse("http://127.0.0.1:3030/").unwrap();
    for url in [&startup,&home] {
        assert!(allow_main_navigation(url,origin,false,true));
        assert!(!allow_main_navigation(url,origin,true,true));
        assert!(allow_main_navigation(url,origin,true,false));
    }
    let external=url::Url::parse("https://example.invalid/").unwrap();
    for loaded in [false,true] { for active in [false,true] {
        assert!(!allow_main_navigation(&external,origin,loaded,active));
    }}
}
