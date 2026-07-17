from __future__ import annotations

import inspect

import chainlit
from chainlit.utils import mount_chainlit
from lingxigraph import CancellationToken, Command, PostgresSaver, StateGraph
from lingxigraph.integrations import AsyncCozeClient, CozeAgentNode, CozeWorkflowNode


def test_chainlit_public_contract() -> None:
    assert callable(chainlit.on_message)
    assert callable(chainlit.set_chat_profiles)
    assert callable(chainlit.password_auth_callback)
    assert callable(mount_chainlit)


def test_lingxigraph_public_contract() -> None:
    assert inspect.isclass(StateGraph)
    assert inspect.isclass(PostgresSaver)
    assert inspect.isclass(CancellationToken)
    assert inspect.isclass(Command)
    assert inspect.isclass(AsyncCozeClient)
    assert inspect.isclass(CozeAgentNode)
    assert inspect.isclass(CozeWorkflowNode)
