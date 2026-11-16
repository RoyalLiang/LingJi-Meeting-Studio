import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const root = resolve(process.env.GITHUB_WORKSPACE);
assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), process.env.TTS_RELEASE_SOURCE_REF);
const {downloadPinned} = await import(pathToFileURL(join(root, 'scripts/prepare-local-asr.mjs')));
await mkdir(join(root, '.agent-runtime'), {recursive: true});
const directory = await mkdtemp(join(root, '.agent-runtime/msix-sdk-probe-'));
const archive = join(directory, 'sdk.nupkg');
await downloadPinned('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg', archive, 'sha256', '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9');
execFileSync('tar.exe', ['-xf', archive, '-C', directory], {stdio: 'inherit'});
const locator = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
const studio = execFileSync(locator, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], {encoding: 'utf8'}).trim();
assert.ok(studio, 'MSVC is required for the standalone diagnostic');
const quote = path => { assert.ok(!/["%!\r\n]/.test(path), 'Unexpected command path'); return '"'+path+'"'; };
const executable = join(directory, 'webview-context-probe.exe');
const command = join(directory, 'build.cmd');
await writeFile(command, '@echo off\r\ncall '+quote(join(studio, 'VC/Auxiliary/Build/vcvars64.bat'))+' >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl /nologo /EHsc /MT /std:c++17 /I'+quote(join(directory, 'build/native/include'))+' '+quote(join(import.meta.dirname, 'test-msix-webview.cpp'))+' /Fe:'+quote(executable)+' /Fo:'+quote(join(directory, 'probe.obj'))+' /link '+quote(join(directory, 'build/native/x64/WebView2LoaderStatic.lib'))+' user32.lib advapi32.lib ole32.lib shell32.lib shlwapi.lib version.lib uuid.lib\r\n');
// cmd /s consumes the outer quotes; preserve the inner path quotes verbatim.
execFileSync('cmd.exe', ['/d', '/s', '/c', '"'+quote(command)+'"'], {stdio: 'inherit', windowsVerbatimArguments: true});
await writeFile(process.env.GITHUB_OUTPUT, 'executable='+executable+'\n', {flag: 'a'});
console.log('Built package-context WebView2 HRESULT diagnostic with SDK 1.0.4258.31');
