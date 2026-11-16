#define NOMINMAX
#include <windows.h>
#include <appmodel.h>
#include <shlobj.h>
#include <wrl.h>
#include <WebView2.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
struct Probe {
  HRESULT immediate = E_PENDING, environment = E_PENDING, controllerImmediate = E_PENDING, controller = E_PENDING;
  bool environmentArrived = false, controllerArrived = false, done = false, abandoned = false;
  ComPtr<ICoreWebView2Environment> env;
  ComPtr<ICoreWebView2Controller> view;
};
std::wstring known(REFKNOWNFOLDERID id, DWORD flags = 0) {
  PWSTR value = nullptr;
  HRESULT hr = SHGetKnownFolderPath(id, flags, nullptr, &value);
  if (FAILED(hr)) throw hr;
  std::wstring result(value); CoTaskMemFree(value); return result;
}
std::wstring packageName(bool family = false) {
  UINT32 count = 0;
  LONG status = family ? GetCurrentPackageFamilyName(&count, nullptr) : GetCurrentPackageFullName(&count, nullptr);
  if (status != ERROR_INSUFFICIENT_BUFFER) throw HRESULT_FROM_WIN32(status);
  std::vector<wchar_t> value(count);
  status = family ? GetCurrentPackageFamilyName(&count, value.data()) : GetCurrentPackageFullName(&count, value.data());
  if (status != ERROR_SUCCESS) throw HRESULT_FROM_WIN32(status);
  return value.data();
}
void probe(std::ostream& out, const char* label, const std::filesystem::path& runtime, const std::filesystem::path& udf) {
  auto state = std::make_shared<Probe>();
  auto start = Clock::now();
  std::filesystem::create_directories(udf);
  WNDCLASSW cls{}; cls.lpfnWndProc = DefWindowProcW; cls.hInstance = GetModuleHandleW(nullptr); cls.lpszClassName = L"LingJiWebViewProbe";
  if (!RegisterClassW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) throw HRESULT_FROM_WIN32(GetLastError());
  HWND window = CreateWindowW(cls.lpszClassName, L"", WS_OVERLAPPEDWINDOW, 0, 0, 640, 480, nullptr, nullptr, cls.hInstance, nullptr);
  if (!window) throw HRESULT_FROM_WIN32(GetLastError());
  state->immediate = CreateCoreWebView2EnvironmentWithOptions(runtime.c_str(), udf.c_str(), nullptr,
    Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([state, window](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
      if (state->abandoned) return S_OK;
      state->environmentArrived = true; state->environment = hr;
      if (FAILED(hr) || !env) { state->done = true; return S_OK; }
      state->env = env;
      state->controllerImmediate = env->CreateCoreWebView2Controller(window,
        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([state](HRESULT result, ICoreWebView2Controller* view) -> HRESULT {
          if (state->abandoned) { if (view) view->Close(); return S_OK; }
          state->controllerArrived = true; state->controller = result; state->view = view; state->done = true; return S_OK;
        }).Get());
      if (FAILED(state->controllerImmediate)) state->done = true;
      return S_OK;
    }).Get());
  while (SUCCEEDED(state->immediate) && !state->done && Clock::now() - start < std::chrono::seconds(20)) {
    MSG message;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    Sleep(10);
  }
  state->abandoned = true;
  if (state->view) state->view->Close();
  DestroyWindow(window);
  out << "{\"location\":\"" << label << "\",\"immediate\":" << (LONG)state->immediate
      << ",\"environmentArrived\":" << state->environmentArrived << ",\"environment\":" << (LONG)state->environment
      << ",\"controllerImmediate\":" << (LONG)state->controllerImmediate << ",\"controllerArrived\":" << state->controllerArrived
      << ",\"controller\":" << (LONG)state->controller << ",\"elapsedMs\":" << std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-start).count() << "}";
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 4 && (argc != 5 || std::wstring(argv[4]) != L"unpackaged")) return 64;
  const bool packaged = argc == 4;
  std::filesystem::path output(argv[2]);
  { std::ofstream started{std::filesystem::path(output.wstring()+L".started.tmp")}; started << GetCurrentProcessId(); if (!started) return 74; }
  if (!MoveFileExW((output.wstring()+L".started.tmp").c_str(), (output.wstring()+L".started").c_str(), MOVEFILE_WRITE_THROUGH)) return 74;
  std::ostringstream out; out << std::boolalpha;
  HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  try {
    if (FAILED(initialized)) throw initialized;
    UINT32 identityLength = 0;
    LONG identityStatus = GetCurrentPackageFullName(&identityLength, nullptr);
    if (packaged ? packageName() != argv[3] : identityStatus != APPMODEL_ERROR_NO_PACKAGE) throw E_ACCESSDENIED;
    UINT32 length = 0; LONG status = GetPackagePathByFullName(argv[3], &length, nullptr);
    if (status != ERROR_INSUFFICIENT_BUFFER) throw HRESULT_FROM_WIN32(status);
    std::vector<wchar_t> path(length); status = GetPackagePathByFullName(argv[3], &length, path.data());
    if (status != ERROR_SUCCESS) throw HRESULT_FROM_WIN32(status);
    UINT32 familyLength = 0; status = PackageFamilyNameFromFullName(argv[3], &familyLength, nullptr);
    if (status != ERROR_INSUFFICIENT_BUFFER) throw HRESULT_FROM_WIN32(status);
    std::vector<wchar_t> family(familyLength); status = PackageFamilyNameFromFullName(argv[3], &familyLength, family.data());
    if (status != ERROR_SUCCESS) throw HRESULT_FROM_WIN32(status);
    std::filesystem::path runtime(argv[1]);
    if (!std::filesystem::equivalent(runtime, std::filesystem::path(path.data())/L"webview2") || !std::filesystem::is_regular_file(runtime/L"msedgewebview2.exe")) throw E_ACCESSDENIED;
    LPWSTR version = nullptr; HRESULT discovered = GetAvailableCoreWebView2BrowserVersionString(runtime.c_str(), &version);
    std::string digits;
    if (version) { for (size_t i=0; i<64&&version[i]; ++i) if ((version[i]>=L'0'&&version[i]<=L'9')||version[i]==L'.') digits += char(version[i]); CoTaskMemFree(version); }
    GUID id; HRESULT unique = CoCreateGuid(&id); if (FAILED(unique)) throw unique;
    wchar_t text[40]; if (!StringFromGUID2(id, text, 40)) throw E_FAIL; std::wstring suffix = std::wstring(L"LingJi-msix-probe-")+text;
    out << "{\"expectedContextVerified\":true,\"packaged\":" << packaged << ",\"versionResult\":" << (LONG)discovered << ",\"version\":\"" << digits << "\",\"cases\":[";
    probe(out, "roaming", runtime, std::filesystem::path(known(FOLDERID_RoamingAppData))/suffix);
    out << ','; out.flush();
    probe(out, "package-local", runtime, std::filesystem::path(known(FOLDERID_LocalAppData, KF_FLAG_NO_PACKAGE_REDIRECTION))/L"Packages"/family.data()/L"LocalState"/suffix);
    out << "]}";
  } catch (HRESULT error) { out.str(""); out.clear(); out << "{\"probeError\":" << (LONG)error << "}"; }
  catch (const std::system_error& error) { out.str(""); out.clear(); out << "{\"probeSystemError\":" << error.code().value() << "}"; }
  catch (...) { out.str(""); out.clear(); out << "{\"probeError\":\"unexpected\"}"; }
  const auto temporary = output.wstring()+L".tmp";
  { std::ofstream file{std::filesystem::path(temporary)}; file << out.str(); if (!file) return 74; }
  if (!MoveFileExW(temporary.c_str(), output.c_str(), MOVEFILE_WRITE_THROUGH)) return 74;
  if (SUCCEEDED(initialized)) CoUninitialize(); return 0;
}
