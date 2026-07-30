from pathlib import Path

path = Path('.github/scripts/apply-marketplace-runtime-local-source.py')
text = path.read_text()

replacements = {
    'expect(await first.text()).toBe(\'{"version":1}\')': 'expect(yield* Effect.promise(() => first.text())).toBe(\'{"version":1}\')',
    'expect(await cached.text()).toBe(\'{"version":1}\')': 'expect(yield* Effect.promise(() => cached.text())).toBe(\'{"version":1}\')',
    'expect(await refreshed.text()).toBe(\'{"version":2}\')': 'expect(yield* Effect.promise(() => refreshed.text())).toBe(\'{"version":2}\')',
}
for old, new in replacements.items():
    if old not in text:
        raise RuntimeError(f'missing bootstrap fragment: {old}')
    text = text.replace(old, new, 1)

english = '''replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '\"path\": \"./skills/review\"',
    '\"url\": \"./skills/review/\"',
)'''
english_fixed = '''replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '\"path\": \"./skills/review\"',
    '\"url\": \"./skills/review/\"',
    count=2,
)'''
russian = '''replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '\"path\": \"./skills/review\"',
    '\"url\": \"./skills/review/\"',
)'''
russian_fixed = '''replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '\"path\": \"./skills/review\"',
    '\"url\": \"./skills/review/\"',
    count=2,
)'''
for old, new in [(english, english_fixed), (russian, russian_fixed)]:
    if old not in text:
        raise RuntimeError('missing documentation replacement block')
    text = text.replace(old, new, 1)

path.write_text(text)
