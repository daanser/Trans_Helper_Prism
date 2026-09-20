# 许可说明（复合许可）

TransHelper Prism 是「**代码** + **索引数据**」的组合，两者适用不同的许可。
本文件说明整体结构；**代码部分仍以根目录 [`LICENSE`](./LICENSE) 为准**，本文件不改变其效力。

## 一、代码：GPL-3.0-or-later

`backend-cf/`、`frontend/`、`scripts/`、`.github/` 及根目录其余源文件，
均以 **GNU General Public License v3.0 or later** 授权 —— 全文见 [`LICENSE`](./LICENSE)。

## 二、向量索引数据：随上游 wiki 的许可

由本项目从各 wiki 抓取、清洗、分块并向量化后生成的**索引数据**（文本片段与向量），
按来源分别遵循上游许可：

| 来源 wiki | 上游仓库 | 上游许可 | 本项目索引数据 |
|---|---|---|---|
| MtF Wiki | [`project-trans/MtF-wiki`](https://github.com/project-trans/MtF-wiki) | CC BY-SA 4.0 | **CC BY-SA 4.0** |
| FtM Wiki | [`project-trans/FtM-wiki`](https://github.com/project-trans/FtM-wiki) | CC BY-SA 4.0 | **CC BY-SA 4.0** |
| RLE Wiki | [`project-trans/rle-wiki`](https://github.com/project-trans/rle-wiki) | CC BY-SA 4.0 | **CC BY-SA 4.0** |
| Mio MtF Wiki | [`KitsuMio/MioMtFWiki`](https://github.com/KitsuMio/MioMtFWiki) | CC BY-ND 4.0 | 遵循 **CC BY-ND 4.0**：**不对外分发**，且**不参与 AI 伴读** |

- 各 wiki 的**原文著作权归其作者与译者所有**，本项目只做索引与检索。
- **Mio MtF Wiki 不参与 AI 伴读**：其 ND（NoDerivatives）条款不允许演绎，
  而把原文交给模型做摘要、改写或摘编属于演绎。
  建立检索索引与向量化属于**技术处理**，不在该条款限制之列（上游许可说明亦如此界定），
  因此 Mio 的内容仍可被检索、可跳转原文。
- 许可全文：[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/legalcode) ·
  [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/legalcode)

## 三、向量库为什么不随仓库分发

- 索引数据体量大，且以集合形式存放于**托管的 Qdrant Cloud**（按访问量计费）；
- 该服务的访问凭据不可能公开，把索引数据放进公开仓库也没有可用的消费方式。

因此公开的不是数据本身，而是**可完整复现的方法**（见下节）。

## 四、复现方法（公开）

任何人都能按下面的步骤重建本项目的向量库：

1. 用 GitHub API 拉取各 wiki 仓库的 `.md` 文件
   （见 [`backend-cf/scripts/one-shot-import.ts`](./backend-cf/scripts/one-shot-import.ts) 与
   [`backend-cf/scripts/ingest-incremental.ts`](./backend-cf/scripts/ingest-incremental.ts)）；
2. 解析 frontmatter、清洗正文、按标题层级 + 字符窗口分块；
3. 用**开放权重**的 [`BAAI/bge-m3`](https://huggingface.co/BAAI/bge-m3) 在 **1024 维**下编码
   （查询与文档必须同模型、同指令）；
4. 写入向量库（本项目用 Qdrant）；检索时可选用
   [`BAAI/bge-reranker-v2-m3`](https://huggingface.co/BAAI/bge-reranker-v2-m3) 二次重排。

分块参数、原文 URL 拼接规则、按 `git blob sha` 比对做增量更新等细节，
见上述脚本与 [`README.md`](./README.md) 的「数据管线」一节。

## 五、其它

- AI 伴读（LLM 总结 / 追问）的输出由模型生成，**仅供参考，不能替代医生建议**。
- 运行依赖：Cloudflare Workers / Pages（计算）、Qdrant Cloud（向量库）、硅基流动（向量、重排与对话模型）。
