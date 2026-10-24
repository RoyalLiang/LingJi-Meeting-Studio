; Three approved pages; input and accessibility remain native Win32 controls.
!include nsDialogs.nsh
!define LINGJI_BACKGROUND "${__FILEDIR__}\background.bmp"
Var LingJiDialog
Var LingJiBitmap
Var LingJiImage
Var LingJiIcon
Var LingJiIconImage
Var LingJiControl
Var LingJiFolder
Var LingJiBrowseButton
Var LingJiShortcutControl
Var LingJiShortcut
Var LingJiLaunch
Var LingJiInstalling
Var LingJiInitialized
Var LingJiWidth
Var LingJiHeight
Var LingJiDpi
Var LingJiTitleFont
Var LingJiPathFont
Var LingJiBodyFont
Var LingJiBrandFont
Var LingJiPercent
Var LingJiThemeModule

!macro LingJiPlace handle x y width height
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $4 ${handle}
  IntOp $0 $LingJiWidth * ${x}
  IntOp $0 $0 / 800
  IntOp $1 $LingJiHeight * ${y}
  IntOp $1 $1 / 488
  IntOp $2 $LingJiWidth * ${width}
  IntOp $2 $2 / 800
  IntOp $3 $LingJiHeight * ${height}
  IntOp $3 $3 / 488
  System::Call 'user32::SetWindowPos(p r4,p 0,i r0,i r1,i r2,i r3,i 0x14)'
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro LingJiLabel x y width height text title
  ${NSD_CreateLabel} 0 0 0 0 "${text}"
  Pop $LingJiControl
  SetCtlColors $LingJiControl 273D35 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x353D27)'
  !if ${title} == 1
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiTitleFont 1
  !else
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
  !endif
  !insertmacro LingJiPlace $LingJiControl ${x} ${y} ${width} ${height}
!macroend

Function LingJiInitialize
  ${If} $LingJiInitialized == 1
    Return
  ${EndIf}
  StrCpy $LingJiInitialized 1
  SetAutoClose true
  StrCpy $LingJiShortcut 1
  InitPluginsDir
  File /oname=$PLUGINSDIR\lingji-background.bmp "${LINGJI_BACKGROUND}"
  File /oname=$PLUGINSDIR\lingji-ui.dll "${__FILEDIR__}\generated\lingji-ui.dll"
  ; Keep the module loaded while its window-subclass callbacks are registered.
  System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\lingji-ui.dll")p.s'
  Pop $LingJiThemeModule
  ${If} $LingJiThemeModule == 0
    MessageBox MB_OK|MB_ICONSTOP "安装界面无法初始化，请重新下载安装包。"
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\lingji-ui-regular.ttf "${__FILEDIR__}\fonts\lingji-ui-regular.ttf"
  File /oname=$PLUGINSDIR\lingji-ui-semibold.ttf "${__FILEDIR__}\fonts\lingji-ui-semibold.ttf"
  File /oname=$PLUGINSDIR\OFL.txt "${__FILEDIR__}\fonts\OFL.txt"
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\lingji-ui-regular.ttf",i 0x10,p 0)'
  System::Call 'gdi32::AddFontResourceExW(w "$PLUGINSDIR\lingji-ui-semibold.ttf",i 0x10,p 0)'
  CreateFont $LingJiTitleFont "LingJi Installer Sans" 24 600
  CreateFont $LingJiPathFont "Segoe UI" 11
  CreateFont $LingJiBodyFont "LingJi Installer Sans" 11
  CreateFont $LingJiBrandFont "LingJi Installer Sans" 16 500
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i.r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  StrCpy $LingJiDpi $0
  IntOp $1 800 * $0
  IntOp $1 $1 / 96
  IntOp $2 520 * $0
  IntOp $2 $2 / 96
  System::Alloc 40
  Pop $3
  System::Call '*$3(i 40)'
  System::Call 'user32::MonitorFromWindow(p $HWNDPARENT,i 2)p.r4'
  System::Call 'user32::GetMonitorInfoW(p r4,p r3)'
  System::Call '*$3(i,i,i,i,i,i.r4,i.r5,i.r6,i.r7)'
  System::Free $3
  IntOp $6 $6 - $4
  IntOp $6 $6 - $1
  IntOp $6 $6 / 2
  IntOp $6 $6 + $4
  IntOp $7 $7 - $5
  IntOp $7 $7 - $2
  IntOp $7 $7 / 2
  IntOp $7 $7 + $5
  System::Call 'user32::SetWindowPos(p $HWNDPARENT,p 0,i r6,i r7,i r1,i r2,i 0x14)' 
  SetCtlColors $HWNDPARENT 273D35 F8F9F3
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

Function LingJiButtons
  GetDlgItem $5 $HWNDPARENT 1
  SendMessage $5 ${WM_SETFONT} $LingJiBodyFont 1
  !insertmacro LingJiPlace $5 620 419 128 42
  System::Call 'user32::SetWindowPos(p r5,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  ${If} $LingJiInstalling == 1
    System::Call 'user32::SetPropW(p r5,w "LingJiInstallingHide",p 1)'
    ShowWindow $5 0
  ${Else}
    System::Call 'user32::RemovePropW(p r5,w "LingJiInstallingHide")'
    ShowWindow $5 5
  ${EndIf}
  GetDlgItem $5 $HWNDPARENT 2
  SendMessage $5 ${WM_SETFONT} $LingJiBodyFont 1
  ${If} $LingJiInstalling == 1
    !insertmacro LingJiPlace $5 620 419 128 42
    SendMessage $5 ${WM_SETTEXT} 0 "STR:取消安装"
    System::Call 'user32::SetPropW(p r5,w "LingJiSecondaryButton",p 1)'
  ${Else}
    !insertmacro LingJiPlace $5 548 419 56 42
    SendMessage $5 ${WM_SETTEXT} 0 "STR:取消"
    System::Call 'user32::RemovePropW(p r5,w "LingJiSecondaryButton")'
  ${EndIf}
  System::Call 'user32::SetWindowPos(p r5,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  GetDlgItem $5 $HWNDPARENT 3
  ShowWindow $5 0
FunctionEnd

Function LingJiThemeControls
  Call LingJiButtons
  System::Call 'user32::SetWindowPos(p $LingJiBitmap,p 1,i 0,i 0,i 0,i 0,i 0x13)'
  System::Call '$PLUGINSDIR\lingji-ui.dll::LingJiTheme(p $HWNDPARENT,w "$PLUGINSDIR\lingji-background.bmp",p $LingJiFolder,p $LingJiBrowseButton,p $LingJiPercent)'
FunctionEnd

Function LingJiAfterShow
  ${NSD_KillTimer} LingJiAfterShow
  Call LingJiHideChrome
  Call LingJiThemeControls
  System::Call 'user32::RedrawWindow(p $HWNDPARENT,p 0,p 0,i 0x185)'
FunctionEnd

Function LingJiReady
  Call LingJiHideChrome
  ${NSD_CreateTimer} LingJiAfterShow 50
  Call LingJiThemeControls
FunctionEnd

Function LingJiBrand
  ${NSD_CreateIcon} 0 0 0 0 ""
  Pop $LingJiIcon
  ${NSD_SetIconFromInstaller} $LingJiIcon $LingJiIconImage
  !insertmacro LingJiPlace $LingJiIcon 49 35 34 34
  !insertmacro LingJiLabel 98 39 180 34 "聆记" 0
  SendMessage $LingJiControl ${WM_SETFONT} $LingJiBrandFont 1
  !insertmacro LingJiLabel 632 44 116 24 "Windows · x64" 0
  SetCtlColors $LingJiControl 718177 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
  !insertmacro LingJiLabel 52 398 696 1 "" 0
  SetCtlColors $LingJiControl DDE6DC DDE6DC
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0xDCE6DD)'
FunctionEnd

Function LingJiCreatePage
  StrCpy $LingJiInstalling 0
  Call LingJiInitialize
  nsDialogs::Create 1018
  Pop $LingJiDialog
  ${If} $LingJiDialog == error
    Abort
  ${EndIf}
  StrCpy $LingJiFolder 0
  StrCpy $LingJiBrowseButton 0
  StrCpy $LingJiPercent 0
  Call LingJiBackground
  Call LingJiBrand
FunctionEnd

Function LingJiWelcome
  Call SkipIfPassive
  Call LingJiCreatePage
  !insertmacro LingJiLabel 52 106 650 48 "安装聆记" 1
  !insertmacro LingJiLabel 52 155 650 30 "会议录音与智能纪要，随时开始。" 0
  SetCtlColors $LingJiControl 718177 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
  !insertmacro LingJiLabel 52 191 650 28 "✓  本地转录模型已包含" 0
  SetCtlColors $LingJiControl 276952 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x526927)'
  !insertmacro LingJiLabel 52 237 650 26 "安装位置" 0
  SetCtlColors $LingJiControl 718177 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
  ${NSD_CreateDirRequest} 0 0 0 0 "$INSTDIR"
  Pop $LingJiFolder
  SendMessage $LingJiFolder ${WM_SETFONT} $LingJiPathFont 1
  SetCtlColors $LingJiFolder 273D35 FFFFFF
  !insertmacro LingJiPlace $LingJiFolder 52 260 610 46
  ${NSD_CreateBrowseButton} 0 0 0 0 "更改"
  Pop $LingJiBrowseButton
  SendMessage $LingJiBrowseButton ${WM_SETFONT} $LingJiBodyFont 1
  !insertmacro LingJiPlace $LingJiBrowseButton 662 260 86 46
  ${NSD_OnClick} $LingJiBrowseButton LingJiBrowse
  ${NSD_CreateCheckbox} 0 0 0 0 "创建桌面快捷方式"
  Pop $LingJiShortcutControl
  SendMessage $LingJiShortcutControl ${WM_SETFONT} $LingJiBodyFont 1
  !insertmacro LingJiPlace $LingJiShortcutControl 52 326 350 27
  ${If} $LingJiShortcut == 1
    ${NSD_Check} $LingJiShortcutControl
  ${EndIf}
  !insertmacro LingJiLabel 52 431 360 24 "仅为当前用户安装" 0
  SetCtlColors $LingJiControl 718177 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装聆记"
  Call LingJiReady
  nsDialogs::Show
  ${NSD_FreeBitmap} $LingJiImage
  ${NSD_FreeIcon} $LingJiIconImage
FunctionEnd

Function LingJiBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "选择安装位置" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $LingJiFolder $0
  ${EndIf}
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
  !insertmacro LingJiLabel 52 106 650 48 "聆记已准备就绪" 1
  !insertmacro LingJiLabel 52 155 650 30 "应用与本地转录模型已安装完成。" 0
  SetCtlColors $LingJiControl 718177 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
  !insertmacro LingJiLabel 52 238 650 30 "✓  无需启动转录服务器，即可开始记录" 0
  SetCtlColors $LingJiControl 276952 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x526927)'
  ${NSD_CreateCheckbox} 0 0 0 0 "完成后启动聆记"
  Pop $LingJiLaunch
  SendMessage $LingJiLaunch ${WM_SETFONT} $LingJiBodyFont 1
  !insertmacro LingJiPlace $LingJiLaunch 52 306 350 27
  ${NSD_Check} $LingJiLaunch
  !insertmacro LingJiLabel 52 431 540 24 "关闭窗口后，聆记会在系统托盘继续运行" 0
  SetCtlColors $LingJiControl 718177 transparent
  System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
  Call LingJiReady
  nsDialogs::Show
  ${NSD_FreeBitmap} $LingJiImage
  ${NSD_FreeIcon} $LingJiIconImage
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

Function LingJiProgressShow
  StrCpy $LingJiInstalling 1
  Call LingJiInitialize
  FindWindow $LingJiDialog "#32770" "" $HWNDPARENT
  ${If} $LingJiDialog != 0
    StrCpy $LingJiFolder 0
    StrCpy $LingJiBrowseButton 0
    Call LingJiBackground
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "",i 0x50000003,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiIcon
    ${NSD_SetIconFromInstaller} $LingJiIcon $LingJiIconImage
    !insertmacro LingJiPlace $LingJiIcon 49 35 34 34
    ; MUI's instfiles page uses ordinary STATIC children, not an nsDialogs page.
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "聆记",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBrandFont 1
    SetCtlColors $LingJiControl 273D35 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x353D27)'
    !insertmacro LingJiPlace $LingJiControl 98 39 500 34
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "正在安装聆记",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiTitleFont 1
    SetCtlColors $LingJiControl 273D35 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x353D27)'
    !insertmacro LingJiPlace $LingJiControl 52 106 650 48
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "正在准备应用与本地转录能力",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
    SetCtlColors $LingJiControl 718177 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
    !insertmacro LingJiPlace $LingJiControl 52 155 650 30
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "正在安装",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
    SetCtlColors $LingJiControl 273D35 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x353D27)'
    !insertmacro LingJiPlace $LingJiControl 52 231 500 30
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "0%",i 0x50000002,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiPercent
    SendMessage $LingJiPercent ${WM_SETFONT} $LingJiBrandFont 1
    SetCtlColors $LingJiPercent 276952 F2F6EF
    System::Call 'user32::SetPropW(p $LingJiPercent,w "LingJiTextColor",p 0x526927)'
    !insertmacro LingJiPlace $LingJiPercent 650 226 98 34
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0xDCE6DD)'
    !insertmacro LingJiPlace $LingJiControl 52 398 696 1
    GetDlgItem $0 $LingJiDialog 1004
    !insertmacro LingJiPlace $0 52 275 696 7
    GetDlgItem $0 $LingJiDialog 1006
    ShowWindow $0 0
    GetDlgItem $0 $LingJiDialog 1027
    ShowWindow $0 0
    GetDlgItem $0 $LingJiDialog 1016
    ShowWindow $0 0
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "应用文件",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
    SetCtlColors $LingJiControl 718177 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
    !insertmacro LingJiPlace $LingJiControl 52 313 200 26
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "本地转录模型",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
    SetCtlColors $LingJiControl 718177 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
    !insertmacro LingJiPlace $LingJiControl 285 313 220 26
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "完成配置",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
    SetCtlColors $LingJiControl 718177 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
    !insertmacro LingJiPlace $LingJiControl 560 313 188 26
    System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "安装过程中请勿关闭此窗口",i 0x50000000,i 0,i 0,i 0,i 0,p $LingJiDialog,p 0,p 0,p 0)p.s'
    Pop $LingJiControl
    SendMessage $LingJiControl ${WM_SETFONT} $LingJiBodyFont 1
    SetCtlColors $LingJiControl 718177 transparent
    System::Call 'user32::SetPropW(p $LingJiControl,w "LingJiTextColor",p 0x778171)'
    !insertmacro LingJiPlace $LingJiControl 52 431 540 26
    Call LingJiHideChrome
    Call LingJiThemeControls
  ${EndIf}
FunctionEnd

Function LingJiProgressLeave
  ${NSD_FreeIcon} $LingJiIconImage
  ${NSD_FreeBitmap} $LingJiImage
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

