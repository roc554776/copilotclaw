import sys
import json
import os

def main():
    # 1. stdin から GitHub Copilot のコンテキスト（JSON）を読み込む
    try:
        input_data = sys.stdin.read().strip()
        if not input_data:
            return

        payload = json.loads(input_data)
    except Exception:
        # エラー時も Copilot の動作を止めないよう応答を返す
        sys.stdout.write(json.dumps({"continue": True}))
        return

    # 2. イベント名を取得（ファイル名に使用）
    # 記事の仕様(hookEventName)とユーザー提供例(hook_event_name)の両方に対応
    event_name = payload.get("hook_event_name") or payload.get("hookEventName") or "UnknownEvent"

    # 3. ログ保存先ディレクトリの準備
    log_dir = os.path.join("tmp", "github-copilot-hooks-logs")
    os.makedirs(log_dir, exist_ok=True)

    # 4. ログファイルへの書き込み（JSONL形式: 1件1行）
    log_file_path = os.path.join(log_dir, f"{event_name}.log")

    # 受け取ったJSONを1行の文字列に整形（念のため separators を指定して最小化）
    compact_json = json.dumps(payload, separators=(',', ':'), ensure_ascii=False)

    with open(log_file_path, "a", encoding="utf-8") as f:
        f.write(compact_json + "\n")

    # 5. GitHub Copilot へのレスポンス
    sys.stdout.write(json.dumps({"continue": True}))
    sys.stdout.flush()

if __name__ == "__main__":
    main()
