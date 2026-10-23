// Facade for the cnpj module: the company record of a CNPJ (L-54), read from
// the Receita's public data and cached.

export { lookupCnpj, validCnpj, onlyDigits, cnpjLookupEnabled, CNPJ_HOSTS, type CnpjResult, type CnpjRecord } from "./cnpj.lookup";
export { CNPJ_TOOLS } from "./cnpj.mcp";
