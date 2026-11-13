"""Serve the local project dashboard and add tasks to local projects."""
import argparse
from contextlib import contextmanager
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

if os.name == "nt":
    import msvcrt
else:
    import fcntl

HERE = Path(__file__).resolve().parent
INDEX = "management/project.json"
INDEX_LOCATIONS = (INDEX, "project.json")
DIRECTORY_STORE = HERE / ".project-directories.json"
SKIP_DIRECTORIES = {"node_modules", "__pycache__", "vendor", "site-packages"}
is_junction = getattr(os.path, "isjunction", lambda path: False)
STATUSES = {"todo", "in_progress", "blocked", "done", "cancelled"}
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/whale-maid.webp": ("whale-maid.webp", "image/webp"),
    "/deepsea-workshop.webp": ("deepsea-workshop.webp", "image/webp"),
}


class RequestError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def project_path(root, value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("项目路径无效")
    relative = Path(value)
    if relative.anchor or ".." in relative.parts:
        raise ValueError("项目路径越出目录")
    try:
        path = (root / relative).resolve()
    except RuntimeError as error:
        raise ValueError("项目路径无法解析") from error
    if not path.is_relative_to(root):
        raise ValueError("项目路径越出目录")
    return path


def load_project(root):
    invalid = None
    for location in INDEX_LOCATIONS:
        try:
            path = project_path(root, location)
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            validate_project(data)
            return data, location
        except (ValueError, OSError) as error:
            invalid = error
    if invalid:
        raise invalid
    raise FileNotFoundError(root / INDEX)


def validate_project(data):
    if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        raise ValueError("不支持此项目索引版本")
    for key in ("project_id", "name"):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise ValueError(f"项目索引缺少 {key}")
    if not isinstance(data.get("tasks"), list):
        raise ValueError("项目索引缺少任务列表")
    ids = set()
    for task in data["tasks"]:
        if not isinstance(task, dict) or any(
            not isinstance(task.get(key), str) or not task[key].strip()
            for key in ("id", "title", "status")
        ) or task["status"] not in STATUSES:
            raise ValueError("项目索引含有无效任务")
        if task["id"] in ids:
            raise ValueError("项目索引含有重复任务编号")
        ids.add(task["id"])


def can_add(root, project, location):
    if location != INDEX or "revision" in project or project.get("task_source", "local") != "local":
        return False
    try:
        index = project_path(root, INDEX)
        management = project_path(root, "management")
        tasks = project_path(root, "management/tasks")
        lock = project_path(root, "management/.project-init.lock")
    except (ValueError, OSError, RuntimeError):
        return False
    return (
        os.access(index, os.W_OK)
        and os.access(index.parent, os.W_OK | os.X_OK)
        and os.access(management, os.W_OK | os.X_OK)
        and (not tasks.exists() or (tasks.is_dir() and os.access(tasks, os.W_OK | os.X_OK)))
        and (not lock.exists() or (lock.is_file() and os.access(lock, os.W_OK)))
    )


def list_projects(roots):
    projects = []
    issues = []
    for root in roots:
        try:
            project, location = load_project(root)
        except FileNotFoundError:
            issues.append(f"{root.name} 缺少项目索引")
        except (ValueError, OSError):
            issues.append(f"{root.name} 的项目索引无法读取或格式不正确")
        else:
            projects.append((root, project, location))
    counts = {}
    for _, project, _ in projects:
        project_id = project["project_id"]
        counts[project_id] = counts.get(project_id, 0) + 1
    unique = []
    for root, project, location in projects:
        if counts[project["project_id"]] > 1:
            issues.append(f"{root.name} 的项目编号重复")
        else:
            unique.append((root, project, location))
    return unique, issues


def public_project(root, project, location):
    fields = ("project_id", "name", "summary", "type", "stage", "status", "updated_at", "next_task_id")
    task_fields = ("id", "title", "status", "target_path", "completed_at", "blocked_reason")
    return {
        **{key: project.get(key) for key in fields},
        "writable": can_add(root, project, location),
        "tasks": [{key: task.get(key) for key in task_fields} for task in project["tasks"]],
    }


def task_detail(root, task):
    url = task.get("detail_url")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        url = None
    detail = None
    if task.get("detail_path"):
        try:
            detail = project_path(root, task["detail_path"]).read_text(encoding="utf-8")
        except (ValueError, OSError):
            return {"error": "任务详情文件无法读取", "url": url}
    return {"body": detail, "url": url}


@contextmanager
def file_lock(path):
    with path.open("a+b") as lock:
        lock.seek(0)
        if os.name == "nt":
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def project_lock(root):
    return file_lock(project_path(root, "management/.project-init.lock"))


def replace_text(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(content)
            file.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def read_directory_store():
    try:
        raw = DIRECTORY_STORE.read_bytes()
    except FileNotFoundError:
        return (), None
    try:
        saved = json.loads(raw.decode("utf-8"))
        if not isinstance(saved, list) or any(
            not isinstance(path, str) or "\0" in path or not Path(path).is_absolute() for path in saved
        ):
            raise ValueError("项目目录清单无效")
    except ValueError:
        return (), raw
    return tuple(dict.fromkeys(Path(path) for path in saved)), None


def save_directory_store(paths, damaged=None):
    if damaged is not None:
        with tempfile.NamedTemporaryFile(dir=DIRECTORY_STORE.parent, prefix=".project-directories.damaged-", delete=False) as backup:
            backup.write(damaged)
    replace_text(DIRECTORY_STORE, json.dumps([str(path) for path in paths], ensure_ascii=False, indent=2) + "\n")


def resolve_directory(value):
    if not isinstance(value, str) or not value.strip():
        raise RequestError("请选择项目目录")
    try:
        path = Path(value).expanduser()
        if path.is_absolute() and path.is_dir():
            return path.resolve()
    except (OSError, ValueError, RuntimeError):
        pass
    raise RequestError("目录不存在或无法访问")


def browse_directories(value):
    root = resolve_directory(value)
    try:
        with os.scandir(root) as entries:
            names = sorted(
                (entry.name for entry in entries if not entry.name.startswith(".") and entry.is_dir()),
                key=str.casefold,
            )
    except OSError:
        raise RequestError("无法打开此目录") from None
    return {
        "path": str(root),
        "parent": str(root.parent) if root.parent != root else None,
        "folders": [{"name": name, "path": str(root / name)} for name in names],
    }


def scan_directory(root):
    for directory, children, files in os.walk(root):
        children[:] = [
            name for name in children
            if not name.startswith(".") and name not in SKIP_DIRECTORIES
            and not is_junction(Path(directory) / name)
        ]
        if "project.json" not in files and "management" not in children:
            continue
        path = Path(directory)
        try:
            project, location = load_project(path)
        except (ValueError, OSError):
            continue
        if location == "project.json" and path.name == "management":
            try:
                _, parent_location = load_project(path.parent)
            except (ValueError, OSError):
                pass
            else:
                if parent_location == INDEX:
                    continue
        yield path, project


def register_directories(startup_roots, paths):
    if not isinstance(paths, list) or not paths:
        raise RequestError("请至少选择一个项目目录")
    selected = tuple(dict.fromkeys(resolve_directory(value) for value in paths))
    scanned = [dict(scan_directory(root)) for root in selected]
    with file_lock(DIRECTORY_STORE.with_suffix(".lock")):
        saved, damaged = read_directory_store()
        roots = tuple(dict.fromkeys([*startup_roots, *saved]))
        known = set()
        for root in roots:
            try:
                project, _ = load_project(root)
            except (ValueError, OSError):
                continue
            known.add(project["project_id"])
        found = {path: project for matches in scanned for path, project in matches.items()}
        added = []
        skipped = 0
        for path, project in found.items():
            project_id = project["project_id"]
            if path in roots or project_id in known:
                skipped += 1
                continue
            known.add(project_id)
            added.append(path)
        if added or damaged is not None:
            save_directory_store([*saved, *added], damaged)
    return {"added": len(added), "skipped": skipped, "empty": sum(not matches for matches in scanned), "recovered": damaged is not None}


def remove_directory(value):
    if not isinstance(value, str) or "\0" in value or not Path(value).is_absolute():
        raise RequestError("请选择已加入的项目目录")
    with file_lock(DIRECTORY_STORE.with_suffix(".lock")):
        saved, damaged = read_directory_store()
        path = Path(value)
        if path in saved:
            save_directory_store([root for root in saved if root != path], damaged)


def task_input(payload, key, limit, required=True):
    value = payload.get(key, "")
    if not isinstance(value, str) or len(value.strip()) > limit or (required and not value.strip()):
        raise RequestError(f"{key} 内容无效")
    return value.strip()


def save_project(root, project, timestamp):
    project["updated_at"] = timestamp
    replace_text(project_path(root, INDEX), json.dumps(project, ensure_ascii=False, indent=2) + "\n")


def add_task(root, project_id, payload):
    if not isinstance(payload, dict):
        raise RequestError("任务格式无效")
    title = task_input(payload, "title", 120)
    scope = task_input(payload, "scope", 3000, required=False)
    acceptance = task_input(payload, "acceptance", 3000, required=False)
    request_id = task_input(payload, "request_id", 50)
    if not re.fullmatch(r"[a-zA-Z0-9-]+", request_id) or "\n" in title or "\r" in title:
        raise RequestError("任务标题或请求编号无效")
    project, location = load_project(root)
    if project["project_id"] != project_id or not can_add(root, project, location):
        raise RequestError("此项目以只读方式接入", HTTPStatus.FORBIDDEN)
    with project_lock(root):
        project, location = load_project(root)
        if project["project_id"] != project_id or not can_add(root, project, location):
            raise RequestError("此项目以只读方式接入", HTTPStatus.FORBIDDEN)
        for task in project["tasks"]:
            if task.get("request_id") == request_id:
                return task["id"]

        numbers = [int(match[1]) for task in project["tasks"] if (match := re.fullmatch(r"T([0-9]{1,12})", task["id"]))]
        number = max(numbers, default=0) + 1
        marker = f"<!-- kanban-request:{request_id} -->"
        while True:
            task_id = f"T{number:03}"
            relative = f"management/tasks/{task_id}.md"
            detail = project_path(root, relative)
            if not detail.exists():
                break
            if detail.is_file() and detail.read_text(encoding="utf-8").splitlines()[:1] == [marker]:
                break
            number += 1
        sections = [f"{marker}\n# {task_id} {title}"]
        if scope:
            sections.append(f"## 工作范围\n\n{scope}")
        if acceptance:
            sections.append(f"## 验收\n\n{acceptance}")
        sections.append("## 执行记录")
        replace_text(detail, "\n\n".join(sections) + "\n")
        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        project["tasks"].append({
            "id": task_id,
            "title": title,
            "status": "todo",
            "detail_path": relative,
            "created_at": timestamp,
            "request_id": request_id,
        })
        if payload.get("set_next") is True:
            project["next_task_id"] = task_id
        save_project(root, project, timestamp)
        return task_id


def find_task(project, task_id):
    task = next((task for task in project["tasks"] if task["id"] == task_id), None)
    if task is None:
        raise RequestError("任务不存在")
    return task


def update_task(root, args):
    project, location = load_project(root)
    if not can_add(root, project, location):
        raise RequestError("此项目的任务不可由本工具修改")
    with project_lock(root):
        project, location = load_project(root)
        if not can_add(root, project, location):
            raise RequestError("此项目的任务不可由本工具修改")
        task = find_task(project, args.id)
        if task.get("detail_url"):
            raise RequestError("请从外部任务来源更新此任务")
        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        if args.action == "start":
            if task["status"] != "todo":
                raise RequestError("只有待办任务可以开始")
            if task.get("detail_path"):
                project_path(root, task["detail_path"]).read_text(encoding="utf-8")
            task.update(status="in_progress", run_id=uuid4().hex)
        else:
            expected = "done" if args.action == "finish" else "blocked"
            if task["status"] == expected and task.get("run_id") == args.run_id:
                return task
            complete_task(root, project, task, args, timestamp)
        save_project(root, project, timestamp)
        return task


def complete_task(root, project, task, args, timestamp):
    status = "done" if args.action == "finish" else "blocked"
    if not args.run_id or task.get("run_id") != args.run_id:
        raise RequestError("执行编号不匹配，请重新读取任务")
    if task["status"] != "in_progress":
        raise RequestError("只有进行中的任务可以写回")
    record = args.record.read_text(encoding="utf-8").strip()
    reason = args.reason.strip() if status == "blocked" else ""
    if not record or (status == "blocked" and not reason):
        raise RequestError("执行记录和适用的阻塞原因不能为空")

    relative = task.get("detail_path")
    if relative is None:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", task["id"]):
            raise RequestError("请为任务指定项目内的详情文件")
        relative = f"management/tasks/{task['id']}.md"
    detail = project_path(root, relative)
    body = detail.read_text(encoding="utf-8") if detail.exists() else f"# {task['id']} {task['title']}\n\n## 执行记录\n"
    marker = f"<!-- task-run:{args.run_id}:{status} -->"
    other_status = "blocked" if status == "done" else "done"
    lines = body.splitlines()
    if f"<!-- task-run:{args.run_id}:{other_status} -->" in lines:
        raise RequestError("已保存另一种执行结果，请先重试原回写命令")
    if marker not in lines:
        explanation = f"阻塞原因：{reason}\n\n" if reason else ""
        replace_text(detail, f"{body.rstrip()}\n\n### {timestamp}\n\n{marker}\n\n{explanation}{record}\n")
    task.update(status=status, detail_path=relative)
    if status == "done":
        task["completed_at"] = timestamp
    else:
        task["blocked_reason"] = reason
    if project.get("next_task_id") == task["id"]:
        project["next_task_id"] = None


def task_command(argv):
    parser = argparse.ArgumentParser(prog="server.py task")
    actions = parser.add_subparsers(dest="action", required=True)
    for action in ("show", "start", "finish", "block"):
        command = actions.add_parser(action)
        command.add_argument("project", type=Path)
        command.add_argument("id")
        if action in ("finish", "block"):
            command.add_argument("run_id")
            command.add_argument("--record", type=Path, required=True)
        if action == "block":
            command.add_argument("--reason", required=True)
    args = parser.parse_args(argv)
    try:
        root = args.project.expanduser().resolve(strict=True)
        if args.action == "show":
            project, _ = load_project(root)
            task = find_task(project, args.id)
            result = {**task, **task_detail(root, task)}
        else:
            result = update_task(root, args)
    except (RequestError, OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


class DashboardHandler(BaseHTTPRequestHandler):
    def reply(self, body, content_type, status=HTTPStatus.OK, *, head=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def reply_json(self, data, status=HTTPStatus.OK):
        self.reply(json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8", status, head=self.command == "HEAD")

    def check_host(self):
        port = self.server.server_port
        if self.headers.get("Host") not in {f"localhost:{port}", f"127.0.0.1:{port}"}:
            raise RequestError("请通过本机地址打开看板", HTTPStatus.FORBIDDEN)

    def get(self, head=False):
        self.check_host()
        request = urlsplit(self.path)
        if request.path in ASSETS:
            filename, content_type = ASSETS[request.path]
            self.reply((HERE / "public" / filename).read_bytes(), content_type, head=head)
            return
        params = parse_qs(request.query)
        if request.path == "/api/directories":
            self.reply_json(browse_directories(params.get("path", [str(HERE.parent)])[0]))
            return
        if request.path not in {"/api/projects", "/api/task"}:
            raise RequestError("页面不存在", HTTPStatus.NOT_FOUND)
        saved, damaged = read_directory_store()
        roots = tuple(dict.fromkeys([*self.server.project_roots, *saved]))
        projects, issues = list_projects(roots)
        if request.path == "/api/projects":
            if damaged is not None:
                issues.insert(0, "目录清单已损坏。重新导入项目时会备份旧清单并恢复使用。")
            self.reply_json({"projects": [public_project(*entry) for entry in projects], "issues": issues, "directories": [str(root) for root in saved]})
            return
        project_id = params.get("project", [""])[0]
        task_id = params.get("task", [""])[0]
        for root, project, location in projects:
            if project["project_id"] == project_id:
                for task in project["tasks"]:
                    if task["id"] == task_id:
                        detail = task_detail(root, task)
                        if can_add(root, project, location) and not task.get("detail_url"):
                            detail["workflow"] = {"script": str(HERE / "server.py"), "project": str(root)}
                        self.reply_json(detail)
                        return
        raise RequestError("任务不存在，请刷新看板", HTTPStatus.NOT_FOUND)

    def post(self):
        self.check_host()
        if self.path not in {"/api/tasks", "/api/directories", "/api/directories/remove"}:
            raise RequestError("页面不存在", HTTPStatus.NOT_FOUND)
        if self.headers.get("Origin") != f"http://{self.headers['Host']}":
            raise RequestError("请在看板页面提交", HTTPStatus.FORBIDDEN)
        size = self.headers.get("Content-Length", "0")
        if not size.isascii() or not size.isdigit() or len(size) > 5 or not 0 < int(size) <= 32000:
            raise RequestError("提交内容大小无效")
        if self.headers.get_content_type() != "application/json":
            raise RequestError("提交格式无效")
        try:
            payload = json.loads(self.rfile.read(int(size)))
        except (ValueError, UnicodeError):
            raise RequestError("提交格式无效") from None
        if not isinstance(payload, dict):
            raise RequestError("提交格式无效")
        if self.path == "/api/directories":
            self.reply_json(register_directories(self.server.project_roots, payload.get("paths")))
            return
        if self.path == "/api/directories/remove":
            remove_directory(payload.get("path"))
            self.reply_json({"removed": True})
            return
        saved, _ = read_directory_store()
        projects, _ = list_projects(tuple(dict.fromkeys([*self.server.project_roots, *saved])))
        for root, project, _ in projects:
            if project["project_id"] == payload.get("project_id"):
                self.reply_json({"id": add_task(root, project["project_id"], payload)}, HTTPStatus.CREATED)
                return
        raise RequestError("项目不存在，请刷新看板", HTTPStatus.NOT_FOUND)

    def dispatch(self, action):
        try:
            action()
        except RequestError as error:
            self.reply_json({"error": str(error)}, error.status)
        except (OSError, ValueError):
            self.reply_json({"error": "本地文件读取或保存失败，请检查项目目录后重试"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_GET(self):
        self.dispatch(self.get)

    def do_HEAD(self):
        self.dispatch(lambda: self.get(head=True))

    def do_POST(self):
        self.dispatch(self.post)


def main():
    if sys.argv[1:2] == ["task"]:
        task_command(sys.argv[2:])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--project", action="append", type=Path, default=[], help="Additional project directory for this run")
    args = parser.parse_args()
    roots = tuple(dict.fromkeys(path.expanduser().resolve() for path in args.project))
    with ThreadingHTTPServer(("127.0.0.1", args.port), DashboardHandler) as server:
        server.project_roots = roots
        print(f"智能体看板 · http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
