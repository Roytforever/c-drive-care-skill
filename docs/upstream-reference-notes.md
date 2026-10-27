# 2026-10-26 开源借鉴与落实

用户要求重新参考两个项目，并纠正静态报告与不可点击内容。以下依据实际源码，未执行上游脚本，也未复制 Rust、Slint 或图标资源。

| 项目与核实版本 | 实际形态 | 借鉴到本项目 |
|---|---|---|
| [governance-kit @32216f480688](https://github.com/Nongfsq/win11-storage-governance-kit/tree/32216f480688cca85a4f7d5b955783493240af49) | Skill、治理手册、安全模型与安装/校验脚本；没有扫描器或网页 UI | 系统基线与异常线索分开；缓存/应用状态/安装修复缓存分开；配置优先，复制、验证、保留旧副本与回退 |
| [windows-disk-cleaner @ea986d425d50](https://github.com/std-microblock/windows-disk-cleaner-skill/tree/ea986d425d50a7aacfc6ea6a3bdb0248ac045095) | Rust 扫描与完整快照、文本/JSON 报告、Slint 原生文件树及用户确认流程；不是静态 HTML | 保留完整目录层级；折叠仅影响展示；更多项可展开；浏览、展开与选择独立；逻辑/分配/完整性口径清楚 |

## 具体来源和对应实现

- [governance safety-model](https://github.com/Nongfsq/win11-storage-governance-kit/blob/32216f480688cca85a4f7d5b955783493240af49/skills/win11-storage-governance/references/safety-model.md)：采用可重建、先调查、保护等语义。自定义目录不因工具名而被标成纯缓存，Maven、Profile、数据库和文档保持保护。
- [governance runbook](https://github.com/Nongfsq/win11-storage-governance-kit/blob/32216f480688cca85a4f7d5b955783493240af49/skills/win11-storage-governance/references/runbook.md)：迁移建议明确源/目标、配置值、重启验证和回退；静态页只导出建议，不执行环境修改。
- [governance handbook](https://github.com/Nongfsq/win11-storage-governance-kit/blob/32216f480688cca85a4f7d5b955783493240af49/docs/windows-11-c-drive-governance.md)：总览加入可展开的占用线索；通过直属字节的最近归属分类，防止父子目录重复合计。
- [cleaner report.rs](https://github.com/std-microblock/windows-disk-cleaner-skill/blob/ea986d425d50a7aacfc6ea6a3bdb0248ac045095/src/report.rs)：新静态扫描默认保存全部已遍历目录，聚合“其余项”只影响图形展示；历史缺失明细说明不能恢复。
- [cleaner gui.rs](https://github.com/std-microblock/windows-disk-cleaner-skill/blob/ea986d425d50a7aacfc6ea6a3bdb0248ac045095/src/gui.rs)、[selection.rs](https://github.com/std-microblock/windows-disk-cleaner-skill/blob/ea986d425d50a7aacfc6ea6a3bdb0248ac045095/src/selection.rs)：更多列表增量展示；浏览不改变清单选择，跨页保留选择，默认未勾选。
- [cleaner model.rs](https://github.com/std-microblock/windows-disk-cleaner-skill/blob/ea986d425d50a7aacfc6ea6a3bdb0248ac045095/src/model.rs)：显式保留扫描时间、错误、跳过、截断、逻辑字节；本项目没有测磁盘分配量，因此不生成虚假的 allocated 数值。

暂未加入前后快照差异页：需要处理不同范围/完整性的可比性，不能直接把两次数字相减称作释放收益。现阶段提供快照保存与重新导入。

## 不照搬的内容与许可

上游示例中的直接删除、junction 和回滚命令不会变成报告执行按钮。上游原生扫描器、句柄核对、MFT 能力也不会被误称为本 Python 扫描器具备。

governance-kit 为 MIT；cleaner 主项目为 Apache-2.0，其 Slint 和图标有独立条款，参见 [THIRD_PARTY_NOTICES](https://github.com/std-microblock/windows-disk-cleaner-skill/blob/ea986d425d50a7aacfc6ea6a3bdb0248ac045095/THIRD_PARTY_NOTICES.md)。本项目只借鉴流程与交互思想，使用自己已有的 React/Lucide 技术栈。
