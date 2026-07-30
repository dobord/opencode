from pathlib import Path

path = Path("packages/opencode/test/skill/skill.test.ts")
text = path.read_text()
old = "const it = testEffect(Layer.mergeAll(LayerNode.compile(Skill.node), node, testInstanceStoreLayer))"
new = """const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Skill.node, Config.node, MarketplaceRegistry.node])),
    node,
    testInstanceStoreLayer,
  ),
)"""
if old not in text:
    raise SystemExit("skill test layer anchor not found")
path.write_text(text.replace(old, new, 1))
