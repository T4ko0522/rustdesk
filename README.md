# rustdesk-discord-bot

この Mac の RustDesk ID と一時パスワードを Discord で取得する Bot です。指定したサーバーとユーザー ID の両方が一致する場合だけ実行し、返信は実行者だけに表示します。

## 起動

Node.js 22 以上、[Vite+ CLI (`vp`)](https://viteplus.dev/guide/)、このユーザーで起動した RustDesk 1.5.0 が必要です。RustDesk の設定では一時パスワードによる接続を有効にしてください。Bot は RustDesk と同じ Mac、同じログインユーザーで実行します。

1. Discord Developer Portal で Bot を作り、対象サーバーへ `bot` と `applications.commands` の scope で招待します。管理者権限や Message Content Intent は不要です。
2. 依存を入れ、設定ファイルを作ります。

```sh
npm install
test -f .env || cp .env.example .env
chmod 600 .env
```

3. `.env` に以下を設定します。この Mac 向けのソケットだけを設定した `.env` は作成済みです。トークンはチャットや Git に貼らないでください。

| 変数 | 値 |
| --- | --- |
| `DISCORD_TOKEN` | Bot トークン |
| `DISCORD_GUILD_ID` | 操作するサーバー ID |
| `DISCORD_ALLOWED_USER_IDS` | 許可ユーザー ID。複数はカンマ区切り |
| `DISCORD_ADMIN_USER_IDS` | `/add` を実行できる管理用ユーザー ID。必須。複数はカンマ区切り |
| `ALLOWED_USERS_FILE` | 追加権限の保存先。既定 `data/allowed-users.json`。相対パスは起動ディレクトリ基準 |
| `RUSTDESK_SOCKET_PATH` | このユーザーの IPC ソケット。今回の Mac は `/tmp/RustDesk-501/ipc` |
| `COOLDOWN_MS` | 全体の更新間隔。既定 30000 ミリ秒 |

4. ビルドして起動し、対象サーバーで `/rustdesk` を使います。Mac が起動し、RustDesk と Bot が動作している必要があります。

```sh
vp build
vp run start
```

| コマンド | 動作 |
| --- | --- |
| `/rustdesk` | 現在の ID と一時パスワードを取得します。パスワードは更新しません。 |
| `/rustdesk action:rotate` | 一時パスワードを更新し、変更を読み返して確認してから ID と新しいパスワードを返します。 |
| `/add user:@ユーザー` | 指定ユーザーに `/rustdesk` の取得・更新権限を付与します。管理用ユーザーだけが実行できます。 |

Discord はサブコマンドを登録すると親コマンド単独で実行できないため、`rotate` は任意の `action` 引数の選択肢として登録します。

`/add` は指定サーバー内でのみ実行できます。追加した権限は保存成功後に有効になり、再起動後も保持されます。管理用ユーザーの指定と `/rustdesk` の実行権限は別です。`/add` で追加されたユーザーが、ほかのユーザーに権限を付与することはできません。環境変数の許可ユーザーは保存ファイルへ複製せず、起動時に追加権限と合わせて参照します。保存ファイルが壊れている場合は起動に失敗します。

認証情報の返信は約60秒後に削除を試みます。この削除はパスワードの失効を意味しません。接続可能期間や接続後の動作は RustDesk の設定に従います。同時要求は取得・更新を通じて拒否します。更新は成功・失敗ともクールダウンの対象ですが、取得はクールダウンの対象外です。

## 構成

- `src/service.ts`: 認可、排他、クールダウン。Discord SDK には依存しません。
- `src/access.ts`: 管理用ユーザーの認可、実行権限の追加と永続化。
- `src/discord.ts`: コマンド登録と非公開返信。
- `src/rustdesk.ts`: 一時パスワードを操作する RustDesk アダプター。
- `src/config.ts` / `src/main.ts`: 設定の検査と組み立て。
- `src/schemas.ts`: 環境設定や IPC 応答、認証情報の検証に使う共通の Zod スキーマと型。

RustDesk 境界は `readCredentials()` と `rotateCredentials()` で、どちらも `Promise<{ id, password }>` を返します。Discord を変更せず別実装へ差し替えられます。Bot は恒久パスワードを取得・変更しません。

一時パスワードの取得・更新には公開 CLI がないため、[RustDesk 1.5.0 の内部 IPC](https://github.com/rustdesk/rustdesk/blob/1.5.0/src/ipc.rs) に依存しています。[公式 CLI の `--password`](https://rustdesk.com/docs/en/client/) は恒久パスワード用です。RustDesk 更新時は IPC 互換性を再確認してください。アダプターは同一ユーザーが所有し、他ユーザーに権限のないディレクトリとソケットだけを使います。

## 検証と切り分け

```sh
npm test
npm run typecheck
```

テストは認可、排他、クールダウン、非公開返信、IPC の分割受信、更新失敗を検査します。通常テストは実機のパスワードを変更しません。

更新できない場合は RustDesk の起動、一時パスワードの有効化、ソケットのパス・所有者・権限を確認してください。エラー返信やログには ID、パスワード、トークン、IPC 応答を出しません。

