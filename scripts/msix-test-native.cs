using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class LingjiActivationManager { }
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILingjiActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, int options, out uint processId);
}
public static class LingjiMsixTest {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);

  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern uint QueryDosDeviceW(string device, StringBuilder target, int count);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int count);
  public static string WindowClass(IntPtr window) { var name=new StringBuilder(256); GetClassNameW(window,name,name.Capacity); return name.ToString(); }
  public static string DevicePath(string path) {
    if (!System.IO.Path.IsPathFullyQualified(path) || path.Length<3 || path[1]!=':') throw new ArgumentException("Expected drive path");
    var target=new StringBuilder(32768);
    if (QueryDosDeviceW(path.Substring(0,2),target,target.Capacity)==0) throw new Win32Exception(Marshal.GetLastWin32Error());
    return target.ToString()+path.Substring(2);
  }
  public static uint Activate(string id) {
    var manager = (ILingjiActivationManager)new LingjiActivationManager();
    try { uint processId; Marshal.ThrowExceptionForHR(manager.ActivateApplication(id, "", 0, out processId)); return processId; }
    finally { Marshal.FinalReleaseComObject(manager); }
  }
  public static string PackageName(uint processId) {
    var process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      uint length=0; int result=GetPackageFullName(process,ref length,null);
      if (result!=122) throw new Win32Exception(result);
      var name=new StringBuilder((int)length); result=GetPackageFullName(process,ref length,name);
      if (result!=0) throw new Win32Exception(result);
      return name.ToString();
    } finally { CloseHandle(process); }
  }
}
