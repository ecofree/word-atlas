"""Publish already validated outputs, rolling back ordinary commit failures.

Staging must be on the destination filesystem so each rename is atomic. Multiple
outputs are committed together with rollback on exceptions; this is not a
power-loss journal. Backups are retained if a rollback itself cannot complete.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import warnings
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable


class OutputRecoveryError(RuntimeError):
    """A failed rollback needs its staging and backups retained for recovery."""


@contextmanager
def staging_directory(parent: Path, prefix: str):
    directory = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
    try:
        yield directory
    except OutputRecoveryError:
        # A preserved .git or an old output may still be in this directory.
        # Never let TemporaryDirectory's finalizer erase the recovery copy.
        raise
    except BaseException:
        shutil.rmtree(directory)
        raise
    else:
        shutil.rmtree(directory)


def publish_outputs(
    outputs: Iterable[tuple[Path, Path]], *, preserve: tuple[str, ...] = ()
) -> None:
    pairs = [(Path(staged), Path(target)) for staged, target in outputs]
    if not pairs:
        raise ValueError("no outputs to publish")
    if preserve and len(pairs) != 1:
        raise ValueError("preserved children require a single directory output")
    if any(Path(name).name != name or name in {".", ".."} for name in preserve):
        raise ValueError("preserved children must be direct names")

    # Validate the complete commit before moving the first existing output.
    for staged, target in pairs:
        if not staged.exists() or staged.is_symlink():
            raise ValueError(f"invalid staged output: {staged.name}")
        if target.is_symlink():
            raise ValueError(f"refusing symlink output: {target.name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if staged.stat().st_dev != target.parent.stat().st_dev:
            raise ValueError("staging and output must be on the same filesystem")
        if preserve and any(os.path.lexists(staged / name) for name in preserve):
            raise ValueError("staging already contains a preserved child")

    backups: list[Path] = []
    moves: list[tuple[Path, Path]] = []

    def move(src: Path, dst: Path) -> None:
        os.replace(src, dst)
        moves.append((src, dst))

    try:
        for staged, target in pairs:
            holder = Path(tempfile.mkdtemp(prefix=f".{target.name}-previous-", dir=target.parent))
            backups.append(holder)
            previous = holder / "output"
            if target.exists():
                move(target, previous)
                for name in preserve:
                    child = previous / name
                    if os.path.lexists(child):
                        move(child, staged / name)
            move(staged, target)
    except BaseException as error:
        failed = []
        for src, dst in reversed(moves):
            try:
                os.replace(dst, src)
            except OSError:
                failed.append(str(dst))
        if failed:
            raise OutputRecoveryError(
                "Output commit failed and rollback needs manual recovery; "
                f"retained backups: {', '.join(map(str, backups))}; "
                f"staged outputs: {', '.join(str(staged) for staged, _ in pairs)}"
            ) from error
        for holder in backups:
            shutil.rmtree(holder)
        raise
    else:
        for holder in backups:
            try:
                shutil.rmtree(holder)
            except OSError as error:
                warnings.warn(f"Published output; old backup remains at {holder}: {error}")
