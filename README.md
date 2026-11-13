# 智能体看板

在一个看板里管理多个项目的任务，让智能体按编号执行并回写结果。

## 启动

下载并解压仓库，在包含 `server.py` 的目录运行以下命令。需要 Python 3.10 或更新版本，无需安装额外依赖。

```sh
python3 server.py
```

Windows 可使用 `py -3 server.py`，下文命令里的 `python3` 也可换成 `py -3`。打开 [看板](http://127.0.0.1:8765/)。端口已被占用时可指定 `--port 8766`，以终端显示的网址为准。按 `Ctrl+C` 停止。

## 从示例开始

1. 把 [examples/demo](examples/demo) 复制到仓库外任意可写位置。以下命令在仓库根目录运行，把 `<示例目录>` 换成副本的完整路径。
2. 在首页点「选择项目目录」，打开示例目录，勾选「选择当前目录」，再点「扫描并加入」。打开「示例项目」，在待办列查看 `T001`。也可以点击「新建任务」，只填标题就能保存。
3. 在智能体会话里指定该项目及任务编号，或依次运行下面的命令体验回写。第二条会返回 `run_id`，将它填入第三条。示例自带 `result.md`，实际任务可以改用自己的 Markdown 执行记录。

   ```sh
   python3 server.py task show "<示例目录>" T001
   python3 server.py task start "<示例目录>" T001
   python3 server.py task finish "<示例目录>" T001 "<run_id>" --record "<示例目录>/result.md"
   ```

4. 点「刷新数据」，在已完成列打开 `T001`，查看执行记录。若任务受阻，可将最后一条中的 `finish` 换成 `block` 并添加 `--reason "阻塞原因"`。

## 接入自己的项目

- 可一次选择多个目录。看板会扫描子目录，优先读取 `management/project.json`，也可读取根目录的 `project.json`。同一个 `project_id` 只会加入一次。
- 使用 [示例索引](examples/demo/management/project.json) 作为模板。保留 `schema_version` 为 1，给每个项目一个稳定且唯一的 `project_id`。空项目可将 `tasks` 设为 `[]`、`next_task_id` 设为 `null`。任务状态可用 `todo`、`in_progress`、`blocked`、`done`、`cancelled`，详情和入口路径相对于项目目录。
- 可写的本地 `management/project.json` 支持新建和回写。仅有根目录索引、由外部系统维护或服务管理的项目可查看，任务变更由其原来源处理。
- 移动项目后重新扫描新目录。可在「选择项目目录」中的「已加入的目录」移除旧路径。移除只取消在看板中的登记。目录清单损坏时仍可导入，重新扫描会先备份旧清单再恢复。
- 已加入的目录保存在本机的 `.project-directories.json`。看板服务使用本机回环地址，方便访问本机项目文件。

右上角「外观」可切换浅色、深色或跟随系统。

## 与项目初始化工具配合使用

可以用 [project-initializer](https://github.com/Selwiro/project-initializer) 初始化或接入项目，生成 `management/project.json` 和任务详情。然后在智能体看板导入同一个项目目录，在网页中查看进度或新建任务。把任务编号交给对应项目的智能体，执行结果写回项目文件后，点击「刷新数据」即可在看板查看。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
