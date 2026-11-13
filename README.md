# 智能体看板

**你在网页上安排任务，智能体在项目里执行，你回到看板查看进度和结果。**

适合同时推进多个项目、用 Codex 等智能体处理任务的人。一个页面就能看到各项目的下一项任务，以及哪些任务正在做、已完成或卡住了。

**导入项目 → 新建任务 → 把执行指令交给智能体 → 刷新看板看结果**

## 快速上手

1. **启动看板。** 下载并解压仓库，在包含 `server.py` 的目录运行 `python3 server.py`。Windows 可以运行 `py -3 server.py`。需要 Python 3.10 或更新版本，无需额外依赖。然后打开 [看板首页](http://127.0.0.1:8765/)。
2. **导入一个项目。** 第一次试用可以先把 [示例项目](examples/demo) 复制到任意可写目录。在看板首页点「选择项目目录」，打开示例副本，勾选「选择当前目录」，再点「扫描并加入」。
3. **交给智能体。** 打开示例项目的待办任务「T001 整理试用记录」，点「复制 Codex 指令」，粘贴到能访问该项目目录的智能体会话。要安排自己的任务，点「新建任务」，填一个标题就能保存。
4. **查看结果。** 智能体执行并回写后，点「刷新数据」。任务完成时，会出现在「已完成」列，点开卡片就能看到执行记录。

## 接入自己的项目

可以用 **[project-initializer](https://github.com/Selwiro/project-initializer)** 初始化新项目或接入已有项目，再把同一个项目目录导入看板。它负责建立项目索引和任务记录，看板负责展示进度和安排任务。

自己的项目也可以直接套用 [示例索引](examples/demo/management/project.json)。将它存为项目目录下的 `management/project.json`，换成自己的项目名称与唯一编号。空项目可以把 `tasks` 设为 `[]`、`next_task_id` 设为 `null`。

<details>
<summary>目录扫描和任务权限</summary>

- 可一次勾选多个目录，看板会扫描它们的子目录。同一个 `project_id` 只加入一次。
- 可写的本地 `management/project.json` 支持新建和回写任务。只有根目录 `project.json` 或任务由外部系统管理的项目可在看板查看。
- 项目移动后，扫描新目录，再在「已加入的目录」中移除旧路径。移除只取消登记。目录清单损坏时，重新导入会备份旧清单并恢复使用。
- 登记信息保存在本机的 `.project-directories.json`。看板在本机运行。

</details>

<details>
<summary>用命令行试一次任务回写</summary>

在看板仓库根目录运行以下命令，将 `<示例目录>` 换成示例副本的完整路径。Windows 可将 `python3` 换成 `py -3`。第二条命令返回 `run_id`，将它填入第三条命令。

```sh
python3 server.py task show "<示例目录>" T001
python3 server.py task start "<示例目录>" T001
python3 server.py task finish "<示例目录>" T001 "<run_id>" --record "<示例目录>/result.md"
```

回到看板刷新即可看到结果。实际任务可使用自己的 Markdown 执行记录。任务受阻时，用 `block` 代替 `finish`，并加上 `--reason "阻塞原因"`。

</details>

<details>
<summary>端口和外观设置</summary>

启动时可以加 `--port 8766` 更换端口，以终端显示的网址为准。按 `Ctrl+C` 停止。右上角「外观」可切换浅色、深色或跟随系统。

</details>

## 许可证

[MIT 许可证](LICENSE)
