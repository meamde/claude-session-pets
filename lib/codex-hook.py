#!/usr/bin/env python3
"""Observation-only Codex hooks. Never approve or block tool execution."""
import json, os, sys, time, re
from pathlib import Path
try:
    data = json.load(sys.stdin)
    sid = data.get('session_id', '')
    if not re.fullmatch(r'[a-fA-F0-9-]{36}', sid):
        sys.exit(0)
    home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    directory = home / 'session-pets-status'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (sid + '.json')
    ev = data.get('hook_event_name')
    if ev == 'SessionEnd':
        target.unlink(missing_ok=True)
        sys.exit(0)
    try:
        prev = json.loads(target.read_text())
    except Exception:
        prev = {}
    if ev == 'SessionStart' and data.get('source') not in (None, 'startup', 'resume'):
        sys.exit(0)
    state = {'UserPromptSubmit': 'working', 'PreToolUse': 'working', 'PostToolUse': 'working',
             'PermissionRequest': 'waiting', 'Stop': 'idle', 'Interrupt': 'idle', 'SessionStart': 'idle'}.get(ev)
    if state is None:
        sys.exit(0)
    name = data.get('tool_name', '')
    ti = data.get('tool_input') or {}
    if not isinstance(ti, dict):
        ti = {'patch': str(ti)}
    task = None
    kind = 'tool'
    if ev == 'UserPromptSubmit':
        task, kind = data.get('prompt'), 'prompt'
    elif name in ('Bash', 'exec_command', 'shell_command'):
        task = ti.get('description') or ti.get('cmd') or ti.get('command') or '명령 실행 중'
        if not ti.get('description') and ('\n' in str(task) or len(str(task)) > 240):
            task = '스크립트 실행 중'
    elif name in ('apply_patch', 'Edit', 'Write'):
        patch = ti.get('patch') or ti.get('input') or ''
        match = re.search(r'\*\*\* (?:Update|Add|Delete) File: (.+)', patch)
        filename = ti.get('file_path') or (match.group(1) if match else '')
        task = (os.path.basename(filename) + ' 수정 중') if filename else '파일 수정 중'
    elif 'request_user_input' in name:
        state, task = ('waiting' if ev == 'PreToolUse' else 'working'), '사용자 답변 대기'
    elif name == 'update_plan':
        task = next((p.get('step') for p in ti.get('plan', []) if p.get('status') == 'in_progress'), None)
    # Retain the previous task when an internal tool has no useful summary.
    if not task and state in ('working', 'waiting'):
        task, kind = prev.get('task'), prev.get('taskKind')
    out = {'state': state, 'cwd': data.get('cwd', ''), 'session_id': sid,
           'transcript_path': data.get('transcript_path'), 'pid': os.getppid(), 'ts': time.time(), 'event': ev}
    if task and state in ('working', 'waiting'):
        out.update(task=' '.join(str(task).split())[:2000], taskKind=kind)
    tmp = target.with_suffix('.' + str(os.getpid()) + '.tmp')
    tmp.write_text(json.dumps(out, ensure_ascii=False))
    os.replace(tmp, target)
    marker = home / 'session-pets-formmode' / sid
    if ev == 'UserPromptSubmit' and marker.exists():
        # Project-local inbox works with Codex workspace-write without global permission changes.
        forms = str(Path(data['cwd']) / '.session-pets' / 'forms')
        schema = {'provider': 'codex', 'sessionId': sid, 'cwd': data['cwd'], 'title': '질문 제목',
                  'items': [{'id': 'choice', 'kind': 'question', 'heading': '질문',
                             'input': {'type': 'radio', 'options': ['선택 1', '선택 2']}}]}
        instruction = ('사용자가 펫 폼 모드를 켰습니다. 사용자에게 질문해야 할 때 ' + forms +
                       '/<고유이름>.json 파일 하나에 다음 스키마로 질문을 작성하고 턴을 끝내세요. '
                       '사용자가 펫에서 폼에 답하면 같은 세션에 답변이 돌아옵니다. '
                       '불필요한 질문을 만들지 말고 명시된 작업은 그대로 진행하세요. '
                       'input.type은 text,textarea,approve,radio,select,checkbox 중 하나입니다. '
                       '파일 생성 권한이 없으면 원래 질문 도구로 질문하세요. 스키마: ' + json.dumps(schema, ensure_ascii=False))
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': instruction}}))
except Exception:
    # An observer must not break the user's task.
    pass
