"""No log line carries an exception's message.

A library's message may quote what it was given, an applicant's address or answer among it, and a
log line may become an error-tracker event that is kept for 30 days. So a logging call
(``logger.<level>``, ``logging.<level>``, any level) inside an ``except`` handler never formats the
exception the handler caught: not as an argument, not in an f-string, not through ``str()``,
``repr()`` or ``.args``, and not through ``traceback.format_exc()``, which prints the message.
It may name the exception's type (``type(e).__name__``), an attribute in ``ALLOWED_ATTRIBUTES``,
``parse_failure_detail(e)`` or ``traceback_without_messages(e)``.

An exception class defined in this repository may be formatted: its message is our code's
sentence. A handler counts as catching one only when every class it names is a ``class``
statement found by the same scan, by its last dotted name. A library class whose words are known
to quote no value is named in ``ALLOWED`` with its reason.

The scan reads every back-end module outside ``tests/``; its own fixture cases prove it flags what
it says and allows what it says.
"""
import ast
from pathlib import Path

BACK_END = Path(__file__).resolve().parent.parent

# A logging call is a call of one of these methods, whatever the logger is called.
LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "fatal", "log"}

# Calls that may be given the caught exception: each reads its type or its frames, never its words.
NAMING_CALLS = {"type", "parse_failure_detail", "traceback_without_messages"}

# Attributes of a caught exception a log line may name, and why each holds no value.
ALLOWED_ATTRIBUTES = {
    "code": "a status code our code or the provider set, never a quoted input",
    "status_code": "an HTTP status code",
}

# Calls that print the exception being handled, its message among it.
TRACEBACK_CALLS = {"format_exc", "format_exception", "format_exception_only", "print_exc"}

# (module, the class as the handler names it): a library exception whose message may be logged.
ALLOWED = {
    ("csv_import.py", "csv.Error"):
        "the reader's own words name a limit (\"field larger than field limit\"), never a cell",
}


def _modules(root):
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root)
        if relative.parts[0] == "tests":
            continue
        if any(part.startswith(".") or part in ("venv", "__pycache__") for part in relative.parts):
            continue
        yield path, relative.as_posix()


def _last_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _caught(handler):
    """The classes ``handler`` names, as written."""
    if handler.type is None:
        return []
    names = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
    return list(names)


def _is_log_call(node):
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr in LOG_METHODS)


def _parents(tree):
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return parents


def _handler_body(handler):
    """Every node of ``handler``'s body, leaving out a nested handler that binds the same name."""
    pending = list(handler.body)
    while pending:
        node = pending.pop()
        yield node
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ExceptHandler) and handler.name and child.name == handler.name:
                continue
            pending.append(child)


def _names_only_its_type(use, parents):
    """Whether the use of the caught exception at ``use`` reads no message."""
    parent = parents.get(use)
    if (isinstance(parent, ast.Call) and use in parent.args
            and _last_name(parent.func) in NAMING_CALLS):
        return True
    return isinstance(parent, ast.Attribute) and parent.attr in ALLOWED_ATTRIBUTES


def _formats_the_exception(call, name, parents):
    arguments = [*call.args, *(keyword.value for keyword in call.keywords)]
    for argument in arguments:
        for node in ast.walk(argument):
            if (name and isinstance(node, ast.Name) and node.id == name
                    and not _names_only_its_type(node, parents)):
                return True
            if (isinstance(node, ast.Call) and _last_name(node.func) in TRACEBACK_CALLS
                    and isinstance(node.func, ast.Attribute)
                    and _last_name(node.func.value) == "traceback"):
                return True
    return False


def findings(root, allowed=ALLOWED):
    """Each logging call under ``root`` that formats a caught exception, as ``file:line: call``."""
    parsed = [(relative, ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
              for path, relative in _modules(root)]
    own_classes = {node.name for _relative, tree in parsed for node in ast.walk(tree)
                   if isinstance(node, ast.ClassDef)}
    found = []
    for relative, tree in parsed:
        parents = _parents(tree)
        for handler in ast.walk(tree):
            if not isinstance(handler, ast.ExceptHandler):
                continue
            caught = _caught(handler)
            if caught and all(_last_name(cls) in own_classes for cls in caught):
                continue
            if caught and all((relative, ast.unparse(cls)) in allowed for cls in caught):
                continue
            for node in _handler_body(handler):
                if _is_log_call(node) and _formats_the_exception(node, handler.name, parents):
                    found.append((relative, node.lineno, ast.unparse(node)))
    return [f"{relative}:{line}: {call}" for relative, line, call in sorted(found)]


def test_no_log_line_formats_a_caught_exception():
    assert findings(BACK_END) == []


def test_every_allowed_pair_is_still_caught_where_it_is_named():
    """An allowance outlives nothing: each pair names a handler the scan still finds."""
    handlers = set()
    for path, relative in _modules(BACK_END):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ExceptHandler):
                handlers.update((relative, ast.unparse(cls)) for cls in _caught(node))

    assert set(ALLOWED) <= handlers


def _scan(tmp_path, source, name="module.py"):
    (tmp_path / name).write_text(source)
    return findings(tmp_path)


def test_the_scan_flags_an_f_string(tmp_path):
    assert _scan(tmp_path, (
        "try:\n"
        "    pass\n"
        "except ValueError as exc:\n"
        "    logger.error(f'Error creating template: {exc}')\n"
    )) == ["module.py:4: logger.error(f'Error creating template: {exc}')"]


def test_the_scan_flags_a_percent_argument(tmp_path):
    assert _scan(tmp_path, (
        "try:\n"
        "    pass\n"
        "except Exception as exc:\n"
        "    logging.warning('Skipping invalid obstacle %s: %s', 1, exc)\n"
    )) == ["module.py:4: logging.warning('Skipping invalid obstacle %s: %s', 1, exc)"]


def test_the_scan_flags_str_repr_and_args(tmp_path):
    assert _scan(tmp_path, (
        "try:\n"
        "    pass\n"
        "except (KeyError, mod.Failure) as e:\n"
        "    logger.info('one %s', str(e))\n"
        "    logger.info('two %r', repr(e))\n"
        "    logger.info('three %s', e.args)\n"
        "    logger.log(30, 'four %s', 'x' + str(e))\n"
    )) == [
        "module.py:4: logger.info('one %s', str(e))",
        "module.py:5: logger.info('two %r', repr(e))",
        "module.py:6: logger.info('three %s', e.args)",
        "module.py:7: logger.log(30, 'four %s', 'x' + str(e))",
    ]


def test_the_scan_flags_a_printed_traceback(tmp_path):
    assert _scan(tmp_path, (
        "try:\n"
        "    pass\n"
        "except Exception:\n"
        "    logger.error(traceback.format_exc())\n"
    )) == ["module.py:4: logger.error(traceback.format_exc())"]


def test_the_scan_allows_the_type_and_what_reads_no_message(tmp_path):
    assert _scan(tmp_path, (
        "try:\n"
        "    pass\n"
        "except Exception as e:\n"
        "    logger.warning('Could not reach Discord: %s', type(e).__name__)\n"
        "    logger.error('status %s', e.code)\n"
        "    logger.warning('Refused: %s', parse_failure_detail(e))\n"
        "    logger.error('Failed\\n%s', traceback_without_messages(e))\n"
        "    raise ValueError(str(e))\n"
    )) == []


def test_the_scan_allows_a_class_of_this_repository(tmp_path):
    (tmp_path / "errors.py").write_text("class UnreadablePdf(Exception):\n    pass\n")

    assert _scan(tmp_path, (
        "try:\n"
        "    pass\n"
        "except errors.UnreadablePdf as exc:\n"
        "    logger.info('Refused an unreadable PDF: %s', exc)\n"
        "try:\n"
        "    pass\n"
        "except (errors.UnreadablePdf, OSError) as exc:\n"
        "    logger.info('Refused: %s', exc)\n"
    )) == ["module.py:8: logger.info('Refused: %s', exc)"]


def test_the_scan_allows_the_allowed_pair_only_where_it_is_named(tmp_path):
    source = (
        "try:\n"
        "    pass\n"
        "except csv.Error as exc:\n"
        "    logger.warning('A CSV could not be parsed: %s', exc)\n"
    )

    assert _scan(tmp_path, source, name="csv_import.py") == []
    assert _scan(tmp_path, source, name="elsewhere.py") == [
        "elsewhere.py:4: logger.warning('A CSV could not be parsed: %s', exc)"]


def test_the_scan_reads_no_test_module(tmp_path):
    (tmp_path / "tests").mkdir()

    assert _scan(tmp_path, (
        "try:\n"
        "    pass\n"
        "except Exception as exc:\n"
        "    logger.error('%s', exc)\n"
    ), name="tests/test_module.py") == []
