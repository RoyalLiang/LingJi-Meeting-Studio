#include <windows.h>
#include <cstdio>
extern "C" int __stdcall LingJiFileMatches(LPCWSTR, LPCWSTR);
int wmain() {
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
  std::printf("installer content-hash tests: %s\n",failures?"FAILED":"passed");
  return failures?1:0;
}
