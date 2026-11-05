#include <windows.h>
#include <commctrl.h>
#include <cstdio>
#include <thread>
#include <cstdlib>
#include <vector>
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
    COLORREF expected=RGB(239,244,237);
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
static int percentageUpdates=0;
LRESULT CALLBACK countPercent(HWND window,UINT message,WPARAM w,LPARAM l,UINT_PTR,DWORD_PTR){if(message==WM_SETTEXT)++percentageUpdates;return DefSubclassProc(window,message,w,l);}
bool stableProgressText(HWND owner,LPCWSTR bitmap){
  INITCOMMONCONTROLSEX controls{sizeof(controls),ICC_PROGRESS_CLASS};InitCommonControlsEx(&controls);
  HWND label=CreateWindowExW(0,L"STATIC",L"",WS_CHILD,0,0,100,30,owner,nullptr,GetModuleHandleW(nullptr),nullptr);
  HWND bar=CreateWindowExW(0,PROGRESS_CLASSW,L"",WS_CHILD,0,40,500,6,owner,nullptr,GetModuleHandleW(nullptr),nullptr);
  LingJiTheme(owner,bitmap,nullptr,nullptr,label);SetWindowSubclass(label,countPercent,90,0);
  SendMessageW(bar,PBM_SETRANGE32,0,100);percentageUpdates=0;
  for(int i=0;i<100;++i)SendMessageW(bar,PBM_SETPOS,42,0);
  SendMessageW(bar,PBM_SETPOS,43,0);bool stable=percentageUpdates==2;
  RemoveWindowSubclass(label,countPercent,90);DestroyWindow(bar);DestroyWindow(label);return stable;
}
std::vector<DWORD> paintedPixels(HWND window){
  RECT r{};GetClientRect(window,&r);HDC source=GetDC(window),target=CreateCompatibleDC(source);
  BITMAPINFO info{};info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);info.bmiHeader.biWidth=r.right;info.bmiHeader.biHeight=-r.bottom;info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;info.bmiHeader.biCompression=BI_RGB;
  void* data=nullptr;HBITMAP image=CreateDIBSection(source,&info,DIB_RGB_COLORS,&data,nullptr,0);
  if(!source||!target||!image||!data){if(image)DeleteObject(image);if(target)DeleteDC(target);if(source)ReleaseDC(window,source);return {};}
  HGDIOBJ previous=SelectObject(target,image);const bool copied=BitBlt(target,0,0,r.right,r.bottom,source,0,0,SRCCOPY)!=FALSE;GdiFlush();
  std::vector<DWORD> pixels(copied?r.right*r.bottom:0);for(size_t i=0;i<pixels.size();++i)pixels[i]=static_cast<DWORD*>(data)[i]&0xffffff;
  SelectObject(target,previous);DeleteObject(image);DeleteDC(target);ReleaseDC(window,source);return pixels;
}
bool cleanProgressRepaint(HWND owner,LPCWSTR bitmap){
  HWND label=CreateWindowExW(0,L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_RIGHT,30,80,180,36,owner,nullptr,GetModuleHandleW(nullptr),nullptr);
  HWND bar=CreateWindowExW(0,PROGRESS_CLASSW,L"",WS_CHILD|WS_VISIBLE,30,130,500,6,owner,nullptr,GetModuleHandleW(nullptr),nullptr);
  SendMessageW(label,WM_SETFONT,reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)),FALSE);
  LingJiTheme(owner,bitmap,nullptr,nullptr,label);
  SetWindowPos(owner,HWND_TOPMOST,30,30,800,400,SWP_SHOWWINDOW);UpdateWindow(owner);
  SendMessageW(bar,PBM_SETRANGE32,0,100);RedrawWindow(label,nullptr,nullptr,RDW_INVALIDATE|RDW_UPDATENOW);
  bool clean=true;
  for(int value:{8,97,100,9,0}){
    SendMessageW(bar,PBM_SETPOS,value,0);UpdateWindow(label);const auto updated=paintedPixels(label);
    RedrawWindow(label,nullptr,nullptr,RDW_INVALIDATE|RDW_UPDATENOW);
    if(updated.empty()||updated!=paintedPixels(label))clean=false;
  }
  DestroyWindow(bar);DestroyWindow(label);ShowWindow(owner,SW_HIDE);return clean;
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
  if(!stableProgressText(owner,argv[1]))++failures;
  if(!cleanProgressRepaint(owner,argv[1])){std::puts("percentage repaint left stale pixels");++failures;}
  DestroyWindow(owner);
  std::printf("installer content-hash and themed-retry tests: %s\n",failures?"FAILED":"passed");
  return failures?1:0;
}
