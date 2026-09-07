// 评审任务发给 harness 的 prompt。【五家逐字相同】，不给任何一家做适配。
//
// 两个设计点：
//
// 1.【要求 JSON 输出】。不是为了好看，是因为判分要拿到 (path, line) 才能和标注对齐。
//    自然语言的评审没法客观判分，一转成 LLM 抽取就又引入了一个模型。
//
// 2.【明确说「不确定就别报」】。这句必须有，否则测不出 Noise Rate 的差异 ——
//    没有这句，乱报是没有代价的，模型就会倾向于把能想到的都列上。
//    真实评审里「乱喷」是有代价的，prompt 要把这个代价说明白。
//
// 3.【明确禁止构建与运行】。这既是场景还原（GitHub 上做 code review 本来就不编译），
//    也是实测逼出来的：不禁的话 agent 会去跑构建，而每次运行都是全新的假 HOME，
//    于是【每一次都要重新下载整条工具链】——实测 pi 拉了整个 Go toolchain 进 home/go/pkg/mod。
//    耗时指标会被网络下载主导，测出来的就不是 harness 的能力差异了。

export const OUTPUT_CONTRACT = `
Output format (this is the only thing that will be read):
Print a single JSON array and nothing else. No prose before or after, no markdown fence.
Each element:
{"path": "<file path relative to repo/>", "from_line": <int>, "to_line": <int>, "category": "<one of: Code Defect | Security Vulnerability | Performance | Maintainability and Readability>", "note": "<one or two sentences: what is wrong and why it matters>"}

Line numbers refer to the file as it exists AFTER this pull request (the code in repo/).
If a finding spans one line, set from_line == to_line.
If you find nothing worth reporting, print exactly: []
`.trim();

export function reviewPrompt() {
  return `
You are reviewing a pull request. The complete source tree at the head commit of this PR is in the directory \`repo/\`. The unified diff of the PR is in \`pr.diff\`. Metadata is in \`PR.md\`.

Review this pull request and report the real problems it introduces or leaves behind.

What counts as worth reporting: bugs, security vulnerabilities, performance problems, and genuine maintainability issues that a competent reviewer would raise.

What does not: style nitpicks, formatting, personal preference, restating what the code does, or speculative concerns you cannot ground in the code you actually read.

Be accurate about location. A finding pointed at the wrong file or the wrong lines is not useful.

Do not report something you are unsure about. An incorrect finding costs the reviewer more time than a missed one, because it has to be investigated and dismissed.

This is a static review: read the code, do not build it, do not run it, do not install dependencies, and do not run the test suite. Reason from the source you can read, the same way a human reviewer does on a pull request page.

${OUTPUT_CONTRACT}
`.trim();
}
