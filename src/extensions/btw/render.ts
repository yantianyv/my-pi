/**
 * btw/render：转发到 shared/markdown（markdown 轻量渲染已上提到 shared 供问卷说明题复用）
 *
 * 保留本文件是为了不动 btw 其它模块的 import 路径与调用签名（renderAnswer 默认两空格缩进）。
 */
export { renderAnswer, wrapText } from "../shared/markdown";
