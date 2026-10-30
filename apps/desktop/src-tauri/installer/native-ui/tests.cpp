#include <windows.h>
#include <cstdio>
#include <thread>
#include <cstdlib>
extern "C" int __stdcall LingJiFileMatches(LPCWSTR, LPCWSTR);
extern "C" int __stdcall LingJiRetry(HWND,LPCWSTR,HFONT,HFONT);
extern "C" void __stdcall LingJiTheme(HWND,LPCWSTR,HWND,HWND,HWND);
struct RetryProbe { HWND owner, dialog = nullptr; };
BOOL CALLBACK findRetry(HWND window, LPARAM data) {
  auto& probe = *reinterpret_cast<RetryProbe*>(data);
  if (GetWindow(window,GW_OWNER) == probe.owner && IsWindowVisible(window) && GetDlgItem(window,IDRETRY) && GetDlgItem(window,IDCANCEL)) { probe.dialog=window; return FALSE; }
  return TRUE;
}
bool retryTest(HWND owner, int response, bool closeWindow = false, LPCWSTR bitmap = nullptr) {
  const DWORD thread = GetCurrentThreadId(); bool checked = false;
  std::thread probe([&] {
    RetryProbe state{owner};
    for (int attempt=0;attempt<200&&!state.dialog;++attempt) { EnumThreadWindows(thread,findRetry,reinterpret_cast<LPARAM>(&state)); if (!state.dialog) Sleep(10); }
    if (!state.dialog) { PostThreadMessageW(thread,WM_QUIT,0,0); return; }
    HWND retry=GetDlgItem(state.dialog,IDRETRY), cancel=GetDlgItem(state.dialog,IDCANCEL);
    RECT bounds{}; GetClientRect(state.dialog,&bounds);
    HDC screen=GetDC(state.dialog), dc=CreateCompatibleDC(screen);
    HBITMAP image=CreateCompatibleBitmap(screen,bounds.right,bounds.bottom);
    HGDIOBJ previous=SelectObject(dc,image);
    SendMessageW(state.dialog,WM_PRINTCLIENT,reinterpret_cast<WPARAM>(dc),PRF_CLIENT);
    COLORREF expected=RGB(242,246,239);
    if (bitmap) {
      HBITMAP source=static_cast<HBITMAP>(LoadImageW(nullptr,bitmap,IMAGE_BITMAP,0,0,LR_LOADFROMFILE|LR_CREATEDIBSECTION));
      if (source) {
        HDC sourceDc=CreateCompatibleDC(dc); HGDIOBJ old=SelectObject(sourceDc,source);
        BITMAP size{}; GetObject(source,sizeof(size),&size);
        expected=GetPixel(sourceDc,MulDiv(8,size.bmWidth,bounds.right),MulDiv(8,size.bmHeight,bounds.bottom));
        SelectObject(sourceDc,old); DeleteDC(sourceDc); DeleteObject(source);
      } else expected=CLR_INVALID;
    }
    const COLORREF actual=GetPixel(dc,8,8);
    checked = retry && cancel && !IsWindowEnabled(owner) && expected!=CLR_INVALID && std::abs(int(GetRValue(actual))-int(GetRValue(expected)))<=2 && std::abs(int(GetGValue(actual))-int(GetGValue(expected)))<=2 && std::abs(int(GetBValue(actual))-int(GetBValue(expected)))<=2;
    SelectObject(dc,previous);DeleteObject(image);DeleteDC(dc);ReleaseDC(state.dialog,screen);
    if (closeWindow) SendMessageW(state.dialog,WM_CLOSE,0,0);
    else SendMessageW(state.dialog,WM_COMMAND,MAKEWPARAM(response,BN_CLICKED),reinterpret_cast<LPARAM>(GetDlgItem(state.dialog,response)));
  });
  const int result=LingJiRetry(owner,bitmap,nullptr,nullptr);probe.join();
  return checked && result==response && IsWindowEnabled(owner);
}
int wmain(int argc, wchar_t* argv[]) {
  if (argc!=2) return 1;
  wchar_t folder[MAX_PATH]{}, path[MAX_PATH]{};
  if (!GetTempPathW(MAX_PATH,folder) || !GetTempFileNameW(folder,L"ljh",0,path)) return 1;
  const wchar_t* empty=L"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const wchar_t* abc=L"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  int failures=0;
  if (LingJiFileMatches(path,empty)!=1 || LingJiFileMatches(path,abc)!=0 || LingJiFileMatches(path,L"bad")!=0) ++failures;
  HANDLE file=CreateFileW(path,GENERIC_WRITE,0,nullptr,TRUNCATE_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
  DWORD written=0;
  if(file==INVALID_HANDLE_VALUE) { DeleteFileW(path);return 1; }
  if(!WriteFile(file,"abc",3,&written,nullptr) || written!=3) ++failures;
  if(LingJiFileMatches(path,abc)!=0) ++failures;
  CloseHandle(file);
  if(LingJiFileMatches(path,abc)!=1) ++failures;
  file=CreateFileW(path,GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file==INVALID_HANDLE_VALUE) { DeleteFileW(path);return 1; }
  SetFilePointer(file,2,nullptr,FILE_BEGIN);WriteFile(file,"d",1,&written,nullptr);CloseHandle(file);
  if(LingJiFileMatches(path,abc)!=0) ++failures;
  DeleteFileW(path);
  if(LingJiFileMatches(path,abc)!=0 || LingJiFileMatches(nullptr,abc)!=0) ++failures;
  HWND owner=CreateWindowExW(0,L"STATIC",L"installer test owner",WS_OVERLAPPEDWINDOW,0,0,800,600,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
  if (!owner) return 1;
  if (!retryTest(owner,IDRETRY) || !retryTest(owner,IDCANCEL) || !retryTest(owner,IDCANCEL,true) || !retryTest(owner,IDRETRY,false,argv[1])) ++failures;
  DestroyWindow(owner);
  std::printf("installer content-hash and themed-retry tests: %s\n",failures?"FAILED":"passed");
  return failures?1:0;
}
