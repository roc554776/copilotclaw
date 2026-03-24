# DeepWiki Q&A with Code Context for Repository: microsoft/vscode
## Q1
1. 多重起動を防止ししたり、2. code CLI で起動して code CLI 自体は detach したり、 3. ゾンビプロセスを残さないようにしたり、というのはそれぞれどうやって実現していますか？
## VS Codeの多重起動防止、CLIデタッチ、ゾンビプロセス回避の実装
VS Codeのプロセス管理における3つの重要な側面をトレース：多重起動防止（ファイルロックとIPC）[1a-1d]、CLIデタッチ（デタッチオプションと環境変数）[2a-2d]、ゾンビプロセス回避（適切なクリーンアップとシグナル処理）[3a-3d]。
### 1. 多重起動防止の実装
ファイルロックとIPCソケットを使用してVS Codeの単一インスタンスを保証する仕組み
### 1a. ファイルロックの取得 (`file_lock.rs:65`)
WindowsではLockFileEx、Unixではflockを使用して排他ロックを取得
```text
match FileLock::acquire(file) {
```
### 1b. シングルトン接続の確立 (`singleton.rs:56`)
ロックファイルを基にシングルトンサーバーまたはクライアント接続を確立
```text
pub async fn acquire_singleton(lock_file: &Path) -> Result<SingletonConnection, CodeError>
```
### 1c. IPCサーバーの起動 (`main.ts:311`)
メインプロセスがIPCサーバーを起動して最初のインスタンスであることを宣言
```text
mainProcessNodeIpcServer = await nodeIPCServe(environmentMainService.mainIPCHandle);
```
### 1d. 既存インスタンスへの接続 (`main.ts:330`)
2番目のインスタンスが最初のインスタンスにIPC接続を試みる
```text
client = await nodeIPCConnect(environmentMainService.mainIPCHandle, 'main');
```
### 2. CLIデタッチの実装
code CLIがElectronプロセスを起動してデタッチする仕組み
### 2a. デタッチオプションの設定 (`cli.ts:473`)
子プロセスをデタッチして起動するためのオプションを設定
```text
const options: SpawnOptions = { detached: true, env };
```
### 2b. コンソールデタッチの設定 (`cli.ts:225`)
Electronがコンソールにアタッチしないように環境変数を設定
```text
env['ELECTRON_NO_ATTACH_CONSOLE'] = '1';
```
### 2c. Electronプロセスの起動 (`cli.ts:488`)
デタッチオプションを使用してElectronメインプロセスを起動
```text
child = spawn(process.execPath, argv.slice(2), options);
```
### 2d. macOSでの起動方法 (`cli.ts:501`)
macOSではopenコマンドを使用してバックグラウンドで起動
```text
spawnArgs.push('-n', '-g');
```
### 3. ゾンビプロセス回避の実装
プロセス終了時の適切なクリーンアップとシグナル処理
### 3a. 終了時のクリーンアップ (`cliProcessMain.ts:94`)
プロセス終了時にリソースを解放するリスナーを登録
```text
process.once('exit', () => this.dispose());
```
### 3b. IPCクライアントのクリーンアップ (`ipc.cp.ts:230`)
IPCクライアントが終了時に適切に破棄されるように設定
```text
const onExit = () => this.disposeClient(); process.once('exit', onExit);
```
### 3c. 子プロセス終了の処理 (`ipc.cp.ts:235`)
子プロセスの終了を検知してリソースをクリーンアップ
```text
this.child.on('exit', (code: any, signal: any) => {
```
### 3d. プロセス終了の待機 (`machine.rs:48`)
指定したPIDのプロセスが終了するまでポーリングして待機
```text
pub async fn wait_until_process_exits(pid: Pid, poll_ms: u64)
```