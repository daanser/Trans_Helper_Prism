// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — tar GNU 长文件名 解析单测 (tasks.md T0.3 补丁)
// 手造 GNU tar（含 typeflag 'L' 长名条目），验证 extractTarGz 能把超 ustar 100 字符的路径
// 通过 'L' 条目恢复。绝不调真实上游/tar 命令。
import { describe, it, expect } from "vitest"
import { gzipSync } from "node:zlib"
import { extractTarGz, resolveContentDir } from "../scripts/one-shot-import"

/** 构造一个 512B tar 头部 + data（补齐到 512 对齐）。GNU 扩展字段可留空（本解包器不校验 checksum）。 */
function buildTarEntry(opts: {
  name: string
  typeflag: string
  data?: string
  size?: number
}): Buffer {
  const nameBuf = Buffer.alloc(100)
  nameBuf.write(opts.name, 0, "utf-8")
  const size = opts.size ?? (opts.data ? Buffer.byteLength(opts.data, "utf-8") : 0)
  // size 字段：12 字节，八进制，右对齐，以 NUL（或空格）结尾
  const sizeField = size.toString(8)
  const sizeBuf = Buffer.concat([Buffer.alloc(12 - sizeField.length - 1, 0x20), Buffer.from(sizeField, "ascii"), Buffer.from([0])])

  const header = Buffer.alloc(512) // 全零
  nameBuf.copy(header, 0)
  sizeBuf.copy(header, 124)
  header.write(opts.typeflag, 156, 1, "ascii")

  // 计算 checksum（规范做法：把 checksum 字段当空格，求和后写回）——此处不上头也可，但写正确更稳。
  const chksumField = Buffer.alloc(8, 0x20)
  chksumField.copy(header, 148)
  let sum = 0
  for (const b of header) sum += b
  const chksum = sum.toString(8).padStart(6, "0")
  Buffer.from(`${chksum}\0 `, "ascii").copy(header, 148)

  // data 补齐到 512 对齐
  const dataField = opts.data ? Buffer.from(opts.data, "utf-8") : Buffer.alloc(0)
  const padded = Buffer.alloc(Math.ceil(size / 512) * 512)
  dataField.copy(padded, 0)

  return Buffer.concat([header, padded])
}

/** 构造一个 complete GNU tar buffer（可能含多个条目）。 */
function buildTar(entries: Buffer[]): Buffer {
  // 末尾补两个 512 全零块表示结束（规范）
  return Buffer.concat([...entries, Buffer.alloc(512), Buffer.alloc(512)])
}

describe("extractTarGz：GNU 长文件名", () => {
  it("typeflag 'L' 条目提供真实长名，恢复正常条目的 name 与内容", () => {
    const longPath =
      "project_trans_MtF_wiki/content/zh-cn/docs/medicine/estrogen/injection/at-home-injection/at-home-injection.md"
    // GNU tar：先写一个 'L' 条目（data 存真实长名），接着写真正文件条目（name 字段为短占位）
    const lEntry = buildTarEntry({ name: "longname", typeflag: "L", data: longPath })
    // 真正文件条目：name 字段放短占位 "at-home-injection.md"（100 字符内），typeflag '0'
    const fileEntry = buildTarEntry({ name: "at-home-injection.md", typeflag: "0", data: "# 注射\n\n正文内容。" })
    const tar = buildTar([lEntry, fileEntry])
    const files = extractTarGz(new Uint8Array(gzipSync(tar)))

    expect(files[longPath]).toBe("# 注射\n\n正文内容。")
    // 占位短名不应作为独立 key 残留
    expect(files["at-home-injection.md"]).toBeUndefined()
  })

  it("普通 ustar 条目（带 prefix 或短名）仍能解析", () => {
    const fileEntry = buildTarEntry({ name: "about.md", typeflag: "0", data: "## 关于\n\n正文。" })
    const tar = buildTar([fileEntry])
    const files = extractTarGz(new Uint8Array(gzipSync(tar)))
    expect(files["about.md"]).toBe("## 关于\n\n正文。")
  })
})

describe("resolveContentDir：per-wiki content_dir 自适应", () => {
  it("在含多语言/多目录的树里挑出 content_dir 子集", () => {
    const tree = {
      "content/zh-cn/_index.md": "a",
      "content/zh-cn/guide/hrt.md": "b",
      "content/ja/nihongo.md": "c", // 应被排除
      "content/en/hello.md": "d",
      "themes/theme/x.md": "e", // 应被排除（FtM content_dir=content）
    }
    expect(resolveContentDir(tree, "content/zh-cn")).toBe("content/zh-cn")
    expect(resolveContentDir(tree, "content")).toBe("content")
    // 不存在的 content_dir 应报错（调用方据此提示）
    expect(() => resolveContentDir(tree, "docs")).toThrow(/不存在/)
  })
})
