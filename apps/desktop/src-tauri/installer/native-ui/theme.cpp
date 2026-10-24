// Paint existing Win32 controls; preserve their input, automation and checkbox semantics.
#include <windows.h>
#include <commctrl.h>
#include <algorithm>
#include <cwchar>

namespace {
constexpr COLORREF jade = RGB(39, 105, 82), ink = RGB(39, 61, 53), muted = RGB(113, 129, 119);
HWND rootWindow = nullptr, folderEdit = nullptr, browseButton = nullptr, percentLabel = nullptr;
HBITMAP background = nullptr;
int px(int value) { return MulDiv(value, static_cast<int>(GetDpiForWindow(rootWindow)), 96); }
void fill(HDC dc, RECT r, COLORREF color) {
  HBRUSH brush = CreateSolidBrush(color); FillRect(dc, &r, brush); DeleteObject(brush);
}
void roundBox(HDC dc, RECT r, COLORREF color, COLORREF border, int radius) {
  HPEN pen = CreatePen(PS_SOLID, 1, border); HBRUSH brush = CreateSolidBrush(color);
  HGDIOBJ oldPen = SelectObject(dc, pen), oldBrush = SelectObject(dc, brush);
  RoundRect(dc, r.left, r.top, r.right, r.bottom, radius, radius);
  SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(pen); DeleteObject(brush);
}
void paper(HWND control, HDC dc, bool outer = false) {
  RECT root{}, bounds{}; GetClientRect(rootWindow, &root); GetClientRect(control, &bounds);
  if (!background) { fill(dc, bounds, RGB(248, 249, 243)); return; }
  POINT origin{};
  if (outer) { RECT position{}; GetWindowRect(control, &position); origin = {position.left,position.top}; MapWindowPoints(nullptr,rootWindow,&origin,1); }
  else MapWindowPoints(control, rootWindow, &origin, 1);
  HDC image = CreateCompatibleDC(dc); HGDIOBJ previous = SelectObject(image, background);
  BITMAP bitmap{}; GetObject(background, sizeof(bitmap), &bitmap);
  const int saved = SaveDC(dc); SetViewportOrgEx(dc, -origin.x, -origin.y, nullptr);
  SetStretchBltMode(dc, HALFTONE);
  StretchBlt(dc, 0, 0, root.right, root.bottom, image, 0, 0, bitmap.bmWidth, bitmap.bmHeight, SRCCOPY);
  RestoreDC(dc, saved); SelectObject(image, previous); DeleteDC(image);
}
void label(HWND window, HDC dc, RECT r, COLORREF color, UINT format) {
  wchar_t text[1024]{}; GetWindowTextW(window, text, 1024);
  HGDIOBJ font = SelectObject(dc, reinterpret_cast<HFONT>(SendMessageW(window, WM_GETFONT, 0, 0)));
  SetBkMode(dc, TRANSPARENT); SetTextColor(dc, color);
  DrawTextW(dc, text, -1, &r, format | DT_SINGLELINE | DT_VCENTER);
  if (font) SelectObject(dc, font);
}
void checkmark(HDC dc, int x, int y, COLORREF color) {
  HPEN pen = CreatePen(PS_SOLID, px(2), color); HGDIOBJ old = SelectObject(dc, pen);
  MoveToEx(dc, x + px(3), y + px(8), nullptr); LineTo(dc, x + px(7), y + px(11)); LineTo(dc, x + px(13), y + px(4));
  SelectObject(dc, old); DeleteObject(pen);
}
void paintButton(HWND window, HDC dc, bool hover) {
  RECT r{}; GetClientRect(window, &r); paper(window, dc);
  const LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
  const bool checkbox = (style & BS_TYPEMASK) == BS_AUTOCHECKBOX || (style & BS_TYPEMASK) == BS_CHECKBOX;
  const bool enabled = IsWindowEnabled(window) != FALSE;
  const bool pressed = (SendMessageW(window, BM_GETSTATE, 0, 0) & BST_PUSHED) != 0;
  if (checkbox) {
    const bool checked = SendMessageW(window, BM_GETCHECK, 0, 0) == BST_CHECKED;
    RECT box{0, (r.bottom - px(16)) / 2, px(16), (r.bottom + px(16)) / 2};
    roundBox(dc, box, checked ? jade : RGB(255,255,255), checked ? jade : RGB(177,194,181), px(4));
    if (checked) checkmark(dc, box.left, box.top, RGB(255,255,255));
    r.left += px(26); label(window, dc, r, enabled ? ink : muted, DT_LEFT);
  } else if (window == browseButton) {
    roundBox(dc, r, hover ? RGB(240,247,239) : RGB(255,255,255), RGB(213,225,214), px(7));
    label(window, dc, r, jade, DT_CENTER);
  } else if (GetDlgCtrlID(window) == IDOK) {
    COLORREF color = !enabled ? RGB(175,197,180) : pressed ? RGB(29,83,65) : hover ? RGB(31,92,71) : jade;
    roundBox(dc, r, color, color, px(7)); label(window, dc, r, RGB(255,255,255), DT_CENTER);
  } else {
    label(window, dc, r, enabled ? muted : RGB(170,182,173), DT_CENTER);
  }
  if (GetFocus() == window && !(SendMessageW(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS)) {
    InflateRect(&r, -px(3), -px(3)); DrawFocusRect(dc, &r);
  }
}
void paintProgress(HWND window, HDC dc) {
  RECT r{}; GetClientRect(window, &r); paper(window, dc);
  PBRANGE range{}; SendMessageW(window, PBM_GETRANGE, FALSE, reinterpret_cast<LPARAM>(&range));
  const int position = static_cast<int>(SendMessageW(window, PBM_GETPOS, 0, 0));
  const int total = std::max(1, range.iHigh - range.iLow);
  roundBox(dc, r, RGB(222,234,221), RGB(222,234,221), px(7));
  r.right = std::clamp<LONG>(MulDiv(r.right, position - range.iLow, total), 0L, r.right);
  if (r.right > 0) roundBox(dc, r, jade, jade, px(7));
}
LRESULT CALLBACK themed(HWND window, UINT message, WPARAM w, LPARAM l, UINT_PTR kind, DWORD_PTR data) {
  if (message == WM_NCDESTROY) { RemoveWindowSubclass(window, themed, kind); return DefSubclassProc(window, message, w, l); }
  if (kind == 3) {
    if (message == WM_NCCALCSIZE) {
      RECT* r = w ? &reinterpret_cast<NCCALCSIZE_PARAMS*>(l)->rgrc[0] : reinterpret_cast<RECT*>(l);
      r->left += px(50); r->right -= px(12); r->top += px(11); r->bottom -= px(11); return 0;
    }
    if (message == WM_NCPAINT) {
      HDC dc = GetWindowDC(window); RECT r{}; GetWindowRect(window,&r); OffsetRect(&r,-r.left,-r.top);
      ExcludeClipRect(dc,px(50),px(11),r.right-px(12),r.bottom-px(11));
      paper(window,dc,true); roundBox(dc,r,RGB(255,255,255),RGB(213,225,214),px(7));
      HPEN pen=CreatePen(PS_SOLID,px(1),muted); HGDIOBJ old=SelectObject(dc,pen),brush=SelectObject(dc,GetStockObject(NULL_BRUSH));
      MoveToEx(dc,px(20),px(16),nullptr); LineTo(dc,px(28),px(16)); LineTo(dc,px(31),px(19)); LineTo(dc,px(38),px(19)); LineTo(dc,px(38),px(30)); LineTo(dc,px(20),px(30)); LineTo(dc,px(20),px(16));
      SelectObject(dc,old); SelectObject(dc,brush); DeleteObject(pen); ReleaseDC(window,dc); return 0;
    }
    return DefSubclassProc(window,message,w,l);
  }
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_MOUSEMOVE && kind == 1 && !data) {
    SetWindowSubclass(window, themed, kind, 1); TRACKMOUSEEVENT tracking{sizeof(tracking), TME_LEAVE, window, 0};
    TrackMouseEvent(&tracking); InvalidateRect(window, nullptr, FALSE);
  }
  if (message == WM_MOUSELEAVE) { SetWindowSubclass(window, themed, kind, 0); InvalidateRect(window, nullptr, FALSE); }
  if (message == WM_PAINT || message == WM_PRINTCLIENT) {
    PAINTSTRUCT paint{}; HDC output = message == WM_PAINT ? BeginPaint(window, &paint) : reinterpret_cast<HDC>(w);
    RECT r{}; GetClientRect(window, &r);
    HDC dc = CreateCompatibleDC(output); HBITMAP bitmap = CreateCompatibleBitmap(output, std::max(1L,r.right), std::max(1L,r.bottom));
    HGDIOBJ previous = SelectObject(dc, bitmap);
    if (kind == 1) paintButton(window, dc, data != 0);
    else if (kind == 2) paintProgress(window, dc);
    else {
      paper(window,dc);
      const HANDLE tone=GetPropW(window,L"LingJiTextColor");
      const COLORREF color=tone ? static_cast<COLORREF>(reinterpret_cast<ULONG_PTR>(tone)) : ink;
      if(r.bottom<=px(2)) fill(dc,r,color);
      else { const LONG_PTR style=GetWindowLongPtrW(window,GWL_STYLE)&SS_TYPEMASK; label(window,dc,r,color,style==SS_RIGHT?DT_RIGHT:style==SS_CENTER?DT_CENTER:DT_LEFT); }
    }
    BitBlt(output, 0, 0, r.right, r.bottom, dc, 0, 0, SRCCOPY);
    SelectObject(dc, previous); DeleteObject(bitmap); DeleteDC(dc);
    if (message == WM_PAINT) EndPaint(window, &paint);
    return 0;
  }
  const LRESULT result = DefSubclassProc(window, message, w, l);
  if (kind == 2 && (message == PBM_SETPOS || message == PBM_SETRANGE || message == PBM_SETRANGE32 || message == PBM_DELTAPOS)) {
    PBRANGE range{}; SendMessageW(window, PBM_GETRANGE, FALSE, reinterpret_cast<LPARAM>(&range));
    const int position = static_cast<int>(SendMessageW(window, PBM_GETPOS, 0, 0));
    wchar_t percentage[16]{}; swprintf_s(percentage, L"%d%%", std::clamp(MulDiv(100,position-range.iLow,std::max(1,range.iHigh-range.iLow)),0,100));
    if (percentLabel) SetWindowTextW(percentLabel, percentage);
    InvalidateRect(window, nullptr, FALSE);
  }
  if (kind == 1 && (message == BM_SETCHECK || message == BM_SETSTATE || message == WM_SETFOCUS || message == WM_KILLFOCUS || message == WM_ENABLE || message == WM_UPDATEUISTATE)) InvalidateRect(window, nullptr, FALSE);
  return result;
}
BOOL CALLBACK apply(HWND window, LPARAM) {
  wchar_t name[64]{}; GetClassNameW(window, name, 64);
  if (wcscmp(name,L"Button") == 0) SetWindowSubclass(window, themed, 1, 0);
  else if (wcscmp(name,PROGRESS_CLASSW) == 0) SetWindowSubclass(window, themed, 2, 0);
  else if (wcscmp(name,L"Static")==0) {
    const LONG_PTR kind=GetWindowLongPtrW(window,GWL_STYLE)&SS_TYPEMASK;
    if(kind==SS_LEFT || kind==SS_CENTER || kind==SS_RIGHT) SetWindowSubclass(window,themed,4,0);
  }
  if (window == folderEdit) {
    SetWindowSubclass(window, themed, 3, 0);
    SetWindowLongPtrW(window,GWL_EXSTYLE,GetWindowLongPtrW(window,GWL_EXSTYLE) & ~WS_EX_CLIENTEDGE);
    SetWindowLongPtrW(window,GWL_STYLE,GetWindowLongPtrW(window,GWL_STYLE) & ~WS_BORDER);
    SendMessageW(window, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, 0);
    SetWindowPos(window,nullptr,0,0,0,0,SWP_NOSIZE|SWP_NOMOVE|SWP_NOZORDER|SWP_FRAMECHANGED);
  }
  InvalidateRect(window, nullptr, TRUE); return TRUE;
}
}
extern "C" void __stdcall LingJiTheme(HWND root, LPCWSTR bitmap, HWND edit, HWND browse, HWND percent) {
  rootWindow = root; folderEdit = edit; browseButton = browse; percentLabel = percent;
  if (!background) background = static_cast<HBITMAP>(LoadImageW(nullptr, bitmap, IMAGE_BITMAP, 0, 0, LR_LOADFROMFILE | LR_CREATEDIBSECTION));
  EnumChildWindows(rootWindow, apply, 0);
}
