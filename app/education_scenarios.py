from __future__ import annotations

import uuid
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping

from .schemas import (
    AudienceRole,
    CanvasPosition,
    DraftEdge,
    DraftNode,
    OrchestrationDraft,
    TemplateName,
)


@dataclass(frozen=True, slots=True)
class ScenarioRole:
    key: str
    display_name: str
    graph_role: str
    description: str
    instructions: str
    position: tuple[float, float]


@dataclass(frozen=True, slots=True)
class EducationScenario:
    key: str
    name: str
    description: str
    audience_roles: tuple[AudienceRole, ...]
    template: TemplateName
    roles: tuple[ScenarioRole, ...]
    edges: tuple[tuple[str, str], ...]
    default_settings: dict[str, Any]

    def payload(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "description": self.description,
            "audience_roles": list(self.audience_roles),
            "template": self.template,
            "roles": [
                {
                    "key": role.key,
                    "display_name": role.display_name,
                    "graph_role": role.graph_role,
                    "description": role.description,
                }
                for role in self.roles
            ],
            "default_settings": deepcopy(self.default_settings),
        }


STUDENT_SUPERVISOR_PROTOCOL = """你是学生学习伙伴的中央协调者。根据学生最新需求，只选择一个下一步角色：
- concept_tutor：解释概念、例子或类比；
- socratic_coach：用递进问题引导学生思考；
- practice_coach：生成与当前水平匹配的分层练习；
- reflection_coach：总结掌握情况、误区和下一步。
你的回复末尾必须单独输出严格 JSON 控制块，例如 {\"next_agent\":\"concept_tutor\"}。
当已经形成完整答复或无需继续分派时输出 {\"next_agent\":\"__end__\"}。不要选择其他目标。"""


STUDENT_LEARNING_COMPANION = EducationScenario(
    key="student_learning_companion",
    name="学生个性化学习伙伴",
    description="由学习协调者按需调度概念讲解、苏格拉底引导、练习生成与反思总结。",
    audience_roles=("student",),
    template="supervisor",
    roles=(
        ScenarioRole(
            "student_supervisor",
            "学习协调者",
            "supervisor",
            "判断学生当前需要解释、提问、练习还是总结。",
            STUDENT_SUPERVISOR_PROTOCOL,
            (100, 260),
        ),
        ScenarioRole(
            "concept_tutor",
            "概念导师",
            "specialist",
            "解释知识点，提供例子和类比。",
            "面向学生准确解释知识点，优先使用贴近生活的例子和类比，并检查学生是否理解。",
            (480, 40),
        ),
        ScenarioRole(
            "socratic_coach",
            "苏格拉底教练",
            "specialist",
            "不直接给答案，通过递进问题引导思考。",
            "不要直接给出最终答案；使用一次一个的递进问题，依据学生回答调整提示强度。",
            (480, 190),
        ),
        ScenarioRole(
            "practice_coach",
            "练习生成器",
            "specialist",
            "根据当前知识点生成分层练习。",
            "根据当前知识点生成基础、进阶和迁移三个层次的练习，并避免立即泄露答案。",
            (480, 340),
        ),
        ScenarioRole(
            "reflection_coach",
            "反思总结助手",
            "specialist",
            "总结掌握情况、误区和下一步建议。",
            "基于当前对话总结已掌握内容、仍存在的误区，并给出清晰可执行的下一步建议。",
            (480, 490),
        ),
    ),
    edges=tuple(
        edge
        for specialist in (
            "concept_tutor",
            "socratic_coach",
            "practice_coach",
            "reflection_coach",
        )
        for edge in (("student_supervisor", specialist), (specialist, "student_supervisor"))
    ),
    default_settings={"max_turns": 6},
)


TEACHER_LESSON_REVIEW = EducationScenario(
    key="teacher_lesson_review",
    name="教师教学方案生成与多维审核",
    description="生成教学设计初稿，并由教学法、难度和评价设计三个维度并行审核后综合定稿。",
    audience_roles=("teacher",),
    template="parallel_review",
    roles=(
        ScenarioRole(
            "source",
            "教学方案生成器",
            "source",
            "根据课程目标生成教学设计初稿。",
            "根据教师提供的学段、学科、课时和课程目标生成结构化教学方案初稿。",
            (80, 250),
        ),
        ScenarioRole(
            "pedagogy_reviewer",
            "教学法审核",
            "reviewer",
            "检查目标、活动与教学方法是否匹配。",
            "从教学法角度审核目标、活动、教学策略与课堂节奏是否一致，给出可执行修改意见。",
            (430, 80),
        ),
        ScenarioRole(
            "difficulty_reviewer",
            "难度审核",
            "reviewer",
            "检查内容是否符合学生认知水平。",
            "审核内容难度、认知负荷、先备知识与差异化支持是否适合目标学生。",
            (430, 250),
        ),
        ScenarioRole(
            "assessment_reviewer",
            "评价设计审核",
            "reviewer",
            "检查练习、测验和评价指标。",
            "审核形成性评价、练习、测验与成功标准能否真实测量课程目标。",
            (430, 420),
        ),
        ScenarioRole(
            "judge",
            "综合评审",
            "judge",
            "汇总意见并生成最终教学方案。",
            "综合初稿与各维度审核，解决冲突意见，输出可直接使用的最终教学方案并列出关键改进。",
            (800, 250),
        ),
    ),
    edges=(
        ("source", "pedagogy_reviewer"),
        ("source", "difficulty_reviewer"),
        ("source", "assessment_reviewer"),
        ("pedagogy_reviewer", "judge"),
        ("difficulty_reviewer", "judge"),
        ("assessment_reviewer", "judge"),
    ),
    default_settings={"max_turns": 8},
)


EDUCATION_SCENARIOS = {
    scenario.key: scenario for scenario in (STUDENT_LEARNING_COMPANION, TEACHER_LESSON_REVIEW)
}


def get_education_scenario(key: str) -> EducationScenario | None:
    return EDUCATION_SCENARIOS.get(key)


def list_education_scenarios() -> tuple[EducationScenario, ...]:
    return tuple(EDUCATION_SCENARIOS.values())


def build_scenario_draft(
    scenario: EducationScenario, agent_mapping: Mapping[str, uuid.UUID]
) -> OrchestrationDraft:
    expected = {role.key for role in scenario.roles}
    provided = set(agent_mapping)
    if provided != expected:
        missing = ", ".join(sorted(expected - provided)) or "none"
        unexpected = ", ".join(sorted(provided - expected)) or "none"
        raise ValueError(f"agent_mapping mismatch; missing={missing}; unexpected={unexpected}")

    nodes = [
        DraftNode(
            id=role.key,
            role=role.graph_role,
            agent_id=agent_mapping[role.key],
            position=CanvasPosition(x=role.position[0], y=role.position[1]),
            config={
                "business_role": role.display_name,
                "description": role.description,
                "instructions": role.instructions,
            },
        )
        for role in scenario.roles
    ]
    return OrchestrationDraft(
        template=scenario.template,
        scenario_key=scenario.key,
        audience_roles=list(scenario.audience_roles),
        nodes=nodes,
        edges=[DraftEdge(source=source, target=target) for source, target in scenario.edges],
        settings=deepcopy(scenario.default_settings),
    )
