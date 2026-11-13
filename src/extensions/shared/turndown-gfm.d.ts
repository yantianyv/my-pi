/**
 * turndown-plugin-gfm 类型补充（该包 1.0.2 无官方 .d.ts）
 *
 * 仅声明本仓库用到的 gfm 组合插件；文件无顶层 import/export（ambient 声明），
 * 只被 tsc 用于类型检查，esbuild 打包时忽略。web-tool.ts 运行时 import 实际包。
 */
declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export function gfm(service: TurndownService): void;
	export function tables(service: TurndownService): void;
	export function strikethrough(service: TurndownService): void;
	export function taskListItems(service: TurndownService): void;
}
