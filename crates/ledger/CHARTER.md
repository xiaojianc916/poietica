# poietica-ledger

**我是什么**：本机唯一的 SQLite 账本。事件是真相，投影与索引是派生。

**我拥有什么**：ledger.sqlite3 这一个库文件、它的连接、它那一条迁移链、
conversation_events / turn_admissions / delivery_outbox / kap_cursors /
thread_projection，以及 index 下的本机索引表。

**谁允许调用我**：组合根（apps/desktop/src-tauri）。领域只看见
poietica_conversation::ports 里的 trait，由组合根把这里注入进去。

**我不许知道什么**：Tauri、webview、KAP 协议形状、UI。时钟是注入的，
不读系统时间。
