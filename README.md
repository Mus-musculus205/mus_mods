# SullyOS 二改分享

这里放的是给 SullyOS 做的几份独立改动。每个目录各自完整，带自己的说明和 LICENSE，按需取用。

| 目录 | 内容 |
| :--- | :--- |
| [`structured-psyche/`](./structured-psyche/) | 主聊天的结构化心象输出：一次请求同时拿到正文和没说出口的心象，补丁形式安装 |
| [`dual-track-update/`](./dual-track-update/) | 安卓版双轨更新：前端改动走 Web 热更新，原生改动走完整 APK，CI 自动判断发哪一种 |

发布包不记录开发仓库名称、分支或提交标识。不同版本的 SullyOS 代码位置可能有差异，请先看各目录的说明再合并。

## License

全部内容作为 SullyOS 的修改与衍生代码，沿用上游的 PolyForm Noncommercial License 1.0.0，仅限非商业用途。完整条款见 [`LICENSE`](./LICENSE)，分发时请保留其中所有 `Required Notice:` 行。
