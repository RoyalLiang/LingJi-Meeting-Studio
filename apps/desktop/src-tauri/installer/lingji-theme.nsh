; Full-window skin over Tauri's pinned NSIS template. Native edit/buttons retain keyboard navigation.
!include nsDialogs.nsh
!define LINGJI_BACKGROUND "${__FILEDIR__}\background.bmp"
Var LingJiDialog
Var LingJiBitmap
Var LingJiImage
Var LingJiIcon
Var LingJiIconImage
Var LingJiControl
Var LingJiFolder
Var LingJiShortcutControl
Var LingJiShortcut
Var LingJiLaunch
Var LingJiInitialized
Var LingJiWidth
Var LingJiHeight
Var LingJiDpi
Var LingJiTitleFont
Var LingJiBodyFont

Function LingJiInitialize
  ${If} $LingJiInitialized == 1
    Return
  ${EndIf}
  StrCpy $LingJiInitialized 1
  ; The standard MUI finish page sets this; our custom finish page retains it.
  SetAutoClose true
  StrCpy $LingJiShortcut 1
  InitPluginsDir
  File /oname=$PLUGINSDIR\lingji-background.bmp "${LINGJI_BACKGROUND}"
  CreateFont $LingJiTitleFont "Microsoft YaHei UI" 18 600
  CreateFont $LingJiBodyFont "Microsoft YaHei UI" 10
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  StrCpy $LingJiDpi $0
  IntOp $1 700 * $0
  IntOp $1 $1 / 96
  IntOp $2 480 * $0
  IntOp $2 $2 / 96
  System::Call 'user32::SetWindowPos(p $HWNDPARENT,p 0,i 0,i 0,i r1,i r2,i 0x16)'
  SetCtlColors $HWNDPARENT 203A2D F7FAF8
FunctionEnd

Function LingJiBackground
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetClientRect(p $HWNDPARENT,p r0)'
  System::Call '*$0(i.r1,i.r2,i.r3,i.r4)'
  System::Free $0
  StrCpy $LingJiWidth $3
  StrCpy $LingJiHeight $4
  System::Call 'user32::GetWindowLongW(p $LingJiDialog,i -16)i.r0'
  IntOp $0 $0 | 0x04000000
  System::Call 'user32::SetWindowLongW(p $LingJiDialog,i -16,i r0)'
  System::Call 'user32::SetWindowPos(p $LingJiDialog,p 0,i 0,i 0,i $LingJiWidth,i $LingJiHeight,i 0x10)'
  System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "",i 0x5400000E,i 0,i 0,i $LingJiWidth,i $LingJiHeight,p $LingJiDialog,p 0,p 0,p 0)p.s'
  Pop $LingJiBitmap
  ${NSD_SetStretchedBitmap} $LingJiBitmap "$PLUGINSDIR\lingji-background.bmp" $LingJiImage
  System::Call 'user32::SetWindowPos(p $LingJiBitmap,p 1,i 0,i 0,i 0,i 0,i 0x13)'
  Call LingJiButtons
FunctionEnd

Function LingJiHideChrome
  ; Outer static controls include MUI headers, branding and separator frames.
  ; FindWindow searches direct siblings, preserving the page's own controls.
  StrCpy $0 0
lingji_chrome_loop:
  FindWindow $0 "Static" "" $HWNDPARENT $0
  ${If} $0 == 0
    Return
  ${EndIf}
  ShowWindow $0 0
  Goto lingji_chrome_loop
FunctionEnd

Function LingJiAfterShow
  ${NSD_KillTimer} LingJiAfterShow
  ; MUI settles its separators when nsDialogs reports the custom page ready.
  Call LingJiHideChrome
  Call LingJiButtons
  System::Call 'user32::RedrawWindow(p $HWNDPARENT,p 0,p 0,i 0x185)'
FunctionEnd

Function LingJiReady
  Call LingJiHideChrome
  ${NSD_CreateTimer} LingJiAfterShow 50
  ; Child controls are created below the first child. Lower the bitmap after all controls exist.
  System::Call 'user32::SetWindowPos(p $LingJiBitmap,p 1,i 0,i 0,i 0,i 0,i 0x13)'
  Call LingJiButtons
FunctionEnd

Function LingJiButtons
  ; Reposition original wizard buttons, retaining native command IDs and tab/Enter behavior.
  IntOp $0 110 * $LingJiDpi
  IntOp $0 $0 / 96
  IntOp $1 34 * $LingJiDpi
  IntOp $1 $1 / 96
  IntOp $2 22 * $LingJiDpi
  IntOp $2 $2 / 96
  IntOp $3 $LingJiWidth - $2
  IntOp $3 $3 - $0
  IntOp $4 $LingJiHeight - $2
  IntOp $4 $4 - $1
  GetDlgItem $5 $HWNDPARENT 1
  SendMessage $5 ${WM_SETFONT} $LingJiBodyFont 1
  System::Call 'user32::SetWindowPos(p r5,p 0,i r3,i r4,i r0,i r1,i 0x10)'
  SetCtlColors $5 F7FAF8 286249
  IntOp $3 $3 - $0
  IntOp $3 $3 - 8
  GetDlgItem $5 $HWNDPARENT 2
  SendMessage $5 ${WM_SETFONT} $LingJiBodyFont 1
  System::Call 'user32::SetWindowPos(p r5,p 0,i r3,i r4,i r0,i r1,i 0x10)'
  IntOp $3 $3 - $0
  IntOp $3 $3 - 8
  GetDlgItem $5 $HWNDPARENT 3
  SendMessage $5 ${WM_SETFONT} $LingJiBodyFont 1
  System::Call 'user32::SetWindowPos(p r5,p 0,i r3,i r4,i r0,i r1,i 0x10)'
  GetDlgItem $5 $HWNDPARENT 1028
  ShowWindow $5 0
FunctionEnd

!macro LingJiLabel x y w h text title
  ${NSD_CreateLabel} ${x} ${y} ${w} ${h} "${text}"
  Pop $LingJiControl
  SetCtlColors $LingJiControl 203A2D transparent
  !if ${title} == 1
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiTitleFont 1
  !else
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
  !endif
!macroend

Function LingJiCreatePage
  Call LingJiInitialize
  nsDialogs::Create 1018
  Pop $LingJiDialog
  ${If} $LingJiDialog == error
    Abort
  ${EndIf}
  Call LingJiBackground
FunctionEnd

Function LingJiWelcome
  Call SkipIfPassive
  Call LingJiCreatePage
  ${NSD_CreateIcon} 10% 12% 42u 42u ""
  Pop $LingJiIcon
  ${NSD_SetIconFromInstaller} $LingJiIcon $LingJiIconImage
  !insertmacro LingJiLabel 28% 15% 65% 30u "欢迎安装聆记" 1
  !insertmacro LingJiLabel 28% 27% 65% 18u "会议录音与智能纪要" 0
  !insertmacro LingJiLabel 12% 40% 80% 18u "安装向导将引导你完成设置。" 0
  !insertmacro LingJiLabel 12% 48% 80% 18u "Windows · x64" 0
  !insertmacro LingJiLabel 12% 60% 80% 24u "录音中关闭窗口，录音与整理继续运行。" 0
  !insertmacro LingJiLabel 12% 72% 80% 28u "本地语音模型需另行部署，可在设置中连接服务。" 0
  Call LingJiReady
  nsDialogs::Show
  ${NSD_FreeBitmap} $LingJiImage
  ${NSD_FreeIcon} $LingJiIconImage
FunctionEnd

Function LingJiDirectory
  Call SkipIfPassive
  Call LingJiCreatePage
  !insertmacro LingJiLabel 12% 12% 80% 30u "选择安装位置" 1
  !insertmacro LingJiLabel 12% 25% 80% 18u "仅为当前用户安装" 0
  !insertmacro LingJiLabel 12% 38% 80% 18u "安装文件夹" 0
  ${NSD_CreateDirRequest} 12% 46% 63% 22u "$INSTDIR"
  Pop $LingJiFolder
  SendMessage $LingJiFolder ${WM_SETFONT} $LingJiBodyFont 1
  ${NSD_CreateBrowseButton} 77% 46% 13% 22u "浏览…"
  Pop $LingJiControl
  SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
  ${NSD_OnClick} $LingJiControl LingJiBrowse
  ${NSD_CreateCheckbox} 12% 60% 35% 20u "创建桌面快捷方式"
  Pop $LingJiShortcutControl
  SendMessage $LingJiShortcutControl ${WM_SETFONT} $LingJiBodyFont 1
  SetCtlColors $LingJiShortcutControl 203A2D transparent
  ${If} $LingJiShortcut == 1
    ${NSD_Check} $LingJiShortcutControl
  ${EndIf}
  Call LingJiReady
  nsDialogs::Show
  ${NSD_FreeBitmap} $LingJiImage
FunctionEnd

Function LingJiBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "选择安装位置" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $LingJiFolder $0
  ${EndIf}
FunctionEnd

Function LingJiDirectoryLeave
  ${NSD_GetText} $LingJiFolder $INSTDIR
  ${If} $INSTDIR == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择安装文件夹。"
    Abort
  ${EndIf}
  ; Validate absolute drive syntax before normalization (C:folder is relative).
  StrLen $0 $INSTDIR
  StrCpy $1 $INSTDIR 1 1
  StrCpy $2 $INSTDIR 1 2
  ${If} $0 < 4
  ${OrIf} $1 != ":"
  ${OrIf} $2 != "\"
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择磁盘中的安装子文件夹。"
    Abort
  ${EndIf}
  ; NSIS GetFullPathName requires the final component to exist. Win32 permits
  ; a new destination, which is the usual first-install case.
  System::Call 'kernel32::GetFullPathNameW(w d,i ${NSIS_MAX_STRLEN},w .r2,p 0)i.r0'
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装路径无法使用，请重新选择。"
    Abort
  ${EndIf}
  StrCpy $INSTDIR $2
  StrLen $0 $INSTDIR
  ${If} $0 < 4
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择磁盘中的安装子文件夹。"
    Abort
  ${EndIf}
  ${NSD_GetState} $LingJiShortcutControl $LingJiShortcut
FunctionEnd

Function LingJiFinish
  Call SkipIfPassive
  Call LingJiCreatePage
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  !insertmacro LingJiLabel 12% 18% 80% 32u "安装完成" 1
  !insertmacro LingJiLabel 12% 34% 80% 18u "聆记已安装到你的电脑。" 0
  !insertmacro LingJiLabel 12% 44% 80% 28u "打开「设置与诊断」，连接转录与纪要服务。" 0
  ${NSD_CreateCheckbox} 12% 58% 35% 20u "立即启动聆记"
  Pop $LingJiLaunch
  SendMessage $LingJiLaunch ${WM_SETFONT} $LingJiBodyFont 1
  SetCtlColors $LingJiLaunch 203A2D transparent
  ${NSD_Check} $LingJiLaunch
  !insertmacro LingJiLabel 12% 70% 80% 24u "关闭窗口后，可从系统托盘重新打开。" 0
  Call LingJiReady
  nsDialogs::Show
  ${NSD_FreeBitmap} $LingJiImage
FunctionEnd

Function LingJiFinishLeave
  ${If} $LingJiShortcut == 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
  ${NSD_GetState} $LingJiLaunch $0
  ${If} $0 == ${BST_CHECKED}
    Call RunMainBinary
  ${EndIf}
FunctionEnd


; Reuse Tauri Restart Manager discovery without its force-shutdown path.
!macro LingJiRequireClosed executablePath productName
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 == ""
    SetErrorLevel 2
    Abort "无法确认聆记是否已退出，请退出聆记后重试。"
  ${EndIf}
  !insertmacro RestartManager_RegisterFile $R0 "${executablePath}"
  StrCpy $9 $0
  !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\runtime\node.exe"
  ${If} $0 != 0
  ${OrIf} $9 != 0
    !insertmacro RestartManager_EndSession $R0
    SetErrorLevel 2
    Abort "无法确认后台状态，请退出聆记后重试。"
  ${EndIf}
  StrCpy $1 0
  StrCpy $2 0
  System::Call 'RSTRTMGR::RmGetList(p R0,*i .r1,*i .r2,p 0,*i .r3)i.r0'
  ${If} $0 == ${ERROR_MORE_DATA}
    !insertmacro RestartManager_EndSession $R0
    IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "聆记仍在后台运行。请先暂停或结束录音，等待补传完成，再从系统托盘选择退出聆记后重试。"
    SetErrorLevel 2
    Abort "聆记或其后台仍在运行。"
  ${ElseIf} $0 != 0
    !insertmacro RestartManager_EndSession $R0
    SetErrorLevel 2
    Abort "无法确认后台状态。"
  ${EndIf}
  !insertmacro RestartManager_EndSession $R0
!macroend

!macro LingJiProgressControl identifier top height
  GetDlgItem $0 $LingJiDialog ${identifier}
  IntOp $1 $LingJiWidth * 12
  IntOp $1 $1 / 100
  IntOp $2 $LingJiHeight * ${top}
  IntOp $2 $2 / 100
  IntOp $3 $LingJiWidth * 76
  IntOp $3 $3 / 100
  IntOp $4 ${height} * $LingJiDpi
  IntOp $4 $4 / 96
  System::Call 'user32::SetWindowPos(p r0,p 0,i r1,i r2,i r3,i r4,i 0x14)'
  SendMessage $0 ${WM_SETFONT} $LingJiBodyFont 1
!macroend

Function LingJiProgressShow
  Call LingJiInitialize
  FindWindow $LingJiDialog "#32770" "" $HWNDPARENT
  ${If} $LingJiDialog != 0
    Call LingJiBackground
    Call LingJiHideChrome
    Call LingJiButtons
    IntOp $1 $LingJiWidth * 12
    IntOp $1 $1 / 100
    IntOp $2 $LingJiHeight * 14
    IntOp $2 $2 / 100
    IntOp $3 $LingJiWidth * 76
    IntOp $3 $3 / 100
    IntOp $4 40 * $LingJiDpi
    IntOp $4 $4 / 96
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "正在安装聆记",i 0x50000000,i r1,i r2,i r3,i r4,p $LingJiDialog,p 0,p 0,p 0)p.r0'
    SendMessage $0 ${WM_SETFONT} $LingJiTitleFont 1
    SetCtlColors $0 203A2D transparent
    !insertmacro LingJiProgressControl 1006 36 24
    ; Dynamic status needs an opaque background to erase the previous filename.
    GetDlgItem $0 $LingJiDialog 1006
    SetCtlColors $0 203A2D F7FAF8
    !insertmacro LingJiProgressControl 1004 46 18
    !insertmacro LingJiProgressControl 1027 56 30
    !insertmacro LingJiProgressControl 1016 65 80
  ${EndIf}
FunctionEnd

Function LingJiProgressLeave
  ${NSD_FreeBitmap} $LingJiImage
FunctionEnd
