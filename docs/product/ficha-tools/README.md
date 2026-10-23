# Ferramentas da Ficha do Contrato

- `gen_schema.py` gera `../contract-schema.v1.json`. Edite o script, não o JSON:
  `python3 gen_schema.py ../contract-schema.v1.json`
- `test_schema.py` valida uma ficha de exemplo e 11 casos que o schema precisa rejeitar
  (valor sem citação, "não encontrado" com valor, dinheiro como float, etc.).
- `check_rules.py` confere se todo caminho de campo em `../risk-rules.v1.yaml` existe no schema,
  se ids e severidades são válidos e se os parâmetros referenciados existem.

Dependências: `pip install jsonschema pyyaml`.
