# Processo de trabalho — do modelo 3D ao site interativo

Este documento registra **como** trabalhamos para chegar ao site publicado (masterplan 3D interativo em three.js com
painel de vendas). Não descreve o conteúdo do projeto; descreve o método: etapas, ferramentas, estratégias, validação
e o uso de skills/agentes. Complementa o `PROCESSO_DE_TRABALHO.md` da fase Blender (feita com Codex) que está em
`G:\Meu Drive\CODEX\SKETCHUP LEGACY`.

---

## 1. Visão geral do fluxo

```
SketchUp (.skp)  ->  Blender (.blend REV01..REV11)  ->  export headless  ->  site estático (three.js)
                     [fase Codex]                       [scripts Python]    [Claude Code]
                                                                                |
                                          backend de vendas (Apps Script + Sheet) <-+-> publicação (GitHub Pages,
                                                                                         artifact single-file)
```

Princípio que guiou tudo: **a fonte da verdade fica no modelo 3D e em scripts reproduzíveis**, nunca em edições manuais
de arquivos gerados. Qualquer coisa que o site mostra pode ser regenerada rodando um script.

---

## 2. Etapas de trabalho

### Etapa 0 — Base geométrica (fase anterior, Codex)
- Leitura dos `.skp` pela SketchUp API, conversão para Blender, quadra piloto, revisões REV01→REV11.
- Saída para nós: um `.blend` organizado em coleções, casas como instâncias de coleção com **custom properties**
  (`property_id`, `lotes`, `modelo`, `padrao_pdf`, `cor_fachada`).
- Lição herdada: numerar revisões (`REV0N`) e manter checkpoints datados do arquivo.

### Etapa 1 — Entender o material antes de codar
- Inspeção do `.blend` pelo **Blender MCP** (`get_scene_info`, `get_object_info`, `execute_blender_code`) para
  descobrir coleções, materiais, custom properties e escalas, sem alterar nada.
- Leitura dos PDFs (plano de subdivisão, plantas das casas) e das imagens de referência.
- Só depois disso definimos o que o site precisaria: casas instanciadas, lotes com polígono, árvores, ruas.

### Etapa 2 — Pipeline de exportação (Blender → web)
- Script único `tools/blender_export.py`, rodado **headless** (`blender -b arquivo.blend --python script.py`).
  Nada é salvo no `.blend`; ele só lê e escreve `assets/models/*.glb` + `data/site.json`.
- Scripts auxiliares para problemas específicos: `headless_ground.py`, `headless_curbs.py`, `blender_trees.py`
  (impostors de árvores), `blender_export_car.py` (carro decimado com materiais consolidados).
- Pós-processamento fora do Blender com Node (`optimize_models.bat`: gltf-transform + Draco) e patches binários
  em Python (`patch_facade.py`) quando o exportador nativo travava.
- Estratégia: **cada bug de exportação virou uma regra no script**, não um conserto manual no arquivo exportado
  (vértice perdido a -246 km, faces invertidas, offset de instância das árvores, etc.).

### Etapa 3 — Dados de negócio e georreferência
- `pdf_lot_labels.py`: "OCR" vetorial dos rótulos de lote no PDF (o texto estava em contornos), casado com os
  polígonos do Blender; casos duvidosos viram recortes de imagem para conferência visual + `label_overrides.json`.
- `georef.py`: amarração do modelo ao grid nacional (EPSG:21292) pela referência impressa na planta;
  `fetch_tiles.py` / `fetch_vast.py`: mosaico de imagem de satélite (Esri, licença compatível).
- `build_properties.py`: registro `data/properties.json` com **ID estável por casa** (`property_id`), para que
  reexportar o modelo nunca perca uma reserva ou venda.
- `fetch_poi.py`: pontos de interesse (Overpass/OpenStreetMap) + rotas e tempos reais (OSRM).
- `fetch_textures.py`: texturas PBR CC0 (Poly Haven), reencodadas para web.

### Etapa 4 — Site (three.js, estático, sem build)
- Código em ES modules (`src/*.js`) servidos direto; nenhum bundler. Menos atrito para iterar e publicar.
- `src/config.js` é o **único lugar de mapeamentos** (tipos, cores, planos, câmera inicial, backend, textos EN/PT).
- Módulos por responsabilidade: cena/UI (`main.js`), iluminação e ciclo dia-noite (`night.js`), carros (`cars.js`),
  aviões (`planes.js`), POIs (`poi.js`), mapa regional (`region.js`), cliente do backend (`api.js`).
- Servidor de desenvolvimento próprio (`tools/dev_server.py`): sem cache + **mock do backend** em `/api`,
  para testar reservar/vender/lead sem tocar no Google. Registrado em `.claude/launch.json` para o preview
  do Claude abrir com um clique.

### Etapa 5 — Rodadas de refinamento com o cliente (feedback loop)
Foram ~9 rodadas curtas. O padrão de cada rodada:
1. O usuário descreve o que quer em linguagem de arquiteto ("dia/noite é a luz do mundo", "sem distâncias em linha
   reta", "o concreto todo claro", "a vista inicial deve ser esta").
2. Traduzimos para uma decisão técnica e registramos o **gosto** dele na memória (ex.: não girar casas para a rua,
   cerca viva ~1 m, mar visível no horizonte, pouca névoa).
3. Implementamos, verificamos no navegador embutido, publicamos.
4. Quando ele ajustava a câmera no próprio viewer, capturávamos `window.__app.camera` via JavaScript e gravávamos em
   `config.js` (o cliente "desenha" a decisão, nós a persistimos).

### Etapa 6 — Backend de vendas
- Google Apps Script + Google Sheet (`tools/backend/Code.gs`): senhas só em *script properties*, lock para
  concorrência, log e leads por e-mail.
- Mesmo contrato de API no mock local e no Apps Script, então o front foi desenvolvido inteiro contra o mock.
- Deploy feito **no Chrome do próprio usuário** (extensão Claude in Chrome), com autorização explícita dele para a
  conta Google; senha passada em chat e nunca gravada em arquivo ou memória.
- `test_backend.py`: 18 verificações (feliz, falha, concorrência) rodadas contra a URL publicada antes da entrega.

### Etapa 7 — Publicação e entrega
- **Site público**: GitHub Pages via `tools/deploy_pages.py` (copia a pasta para um clone, commit, push).
- **Preview compartilhável**: `tools/build_single_html.py` gera um HTML único de ~10 MB (assets em base64,
  módulos inlinados) publicado como **Artifact** do Claude; o mesmo caminho de arquivo é republicado a cada versão.
- Cache-busting obrigatório: `?v=` nos imports + `ASSET_V` a cada mudança (Chrome cacheia agressivamente).
- Backups em tgz do site antes/depois de checkpoints grandes (`output/blender/backups/web_checkpoint_*`).

---

## 3. Como colaboramos

- **Você**: objetivo, gosto visual, decisões de negócio (o que é vendável, senha única, quem recebe leads),
  ações que exigem sua conta (Google, GitHub) e o "ok" para publicar.
- **Claude Code**: investigação, scripts, código, verificação no navegador, publicação, documentação.
- Regras combinadas ao longo do caminho:
  - Nunca colocar senha no site ou na memória.
  - Confirmar antes de ações externas (deploy no GitHub, criar Sheet/Apps Script, usar sua conta).
  - Respostas curtas com o resultado; detalhes técnicos vão para README/memória, não para o chat.
  - Quando algo não pôde ser verificado, dizer explicitamente.

---

## 4. Ferramentas usadas (e para quê)

| Ferramenta | Uso no processo |
| --- | --- |
| **Bash / PowerShell + Python** | Todo o pipeline: exportação, georreferência, OCR de PDF, fetch de dados, build, deploy, testes. |
| **Blender headless** (`blender -b`) | Exportações reproduzíveis sem abrir a UI e sem risco de salvar o `.blend`. |
| **Blender MCP** | Inspeção da cena ao vivo, renders de impostors, export do carro, screenshots do viewport. |
| **Browser pane (preview)** | `launch.json` → dev server; `read_console_messages`, `javascript_tool`, screenshots para verificar cada mudança. |
| **Claude in Chrome** | Deploy do Apps Script na conta Google do usuário (com permissão), incluindo o popup de consentimento. |
| **gh CLI / git** | Repositório e GitHub Pages. |
| **Artifacts** | Preview single-file para o cliente, republicado no mesmo URL. |
| **Memória persistente** (`memory/*.md`) | Localizações, convenções, gotchas e gosto do cliente, para retomar sessões sem reler tudo. |
| **Node (gltf-transform)** | Compressão Draco e limpeza de GLB quando o exportador do Blender falhava. |
| **APIs abertas** | Esri World Imagery, Overpass (OSM), OSRM, Poly Haven — sempre com créditos no site. |

---

## 5. Estratégias que funcionaram

1. **ID estável antes de qualquer feature de vendas.** O `property_id` no Blender desacoplou geometria de status
   comercial; reexportar virou uma operação segura.
2. **Scripts em `tools/` em vez de edições manuais.** Cada correção ficou codificada; o README diz a ordem de
   execução para atualizar a partir do Blender em 4 passos.
3. **Mock local com o mesmo contrato do backend real.** O front ficou pronto e testado antes de existir o Google.
4. **Headless para o pesado, MCP para o exploratório.** Iterar o depsgraph com vegetação ligada levava 15+ min;
   a regra "excluir coleções pesadas da view layer" ficou no script.
5. **Um arquivo de configuração para tudo que é decisão** (`config.js`), para que mudanças de gosto sejam
   alterações de 1 linha.
6. **Verificar no navegador antes de reportar.** Console, rede e screenshot a cada rodada; nunca pedir ao usuário
   para conferir manualmente algo que podíamos conferir.
7. **Registrar gotchas na memória no momento em que aparecem** (vértices perdidos, Draco travando, cache do Chrome,
   rate limit do Overpass, backslashes em heredoc). Isso é o que permitiu retomar o trabalho em sessões novas.
8. **Duas formas de entrega** (site público + HTML único) atendem cliente final e revisão interna sem servidor.
9. **Rodadas curtas.** Cada pedido do cliente virou um ciclo fechado: implementar → verificar → publicar → anotar.

---

## 6. Skills e agentes

- A maior parte do trabalho usou as ferramentas nativas (Bash, edição de arquivos, preview, MCPs). Skills formais
  foram usadas só quando a tarefa se encaixava:
  - **Preview / `run`**: subir o dev server registrado em `.claude/launch.json` e validar mudanças visuais.
  - **Artifacts** (`artifact-design`): publicação do preview single-file com título estável e republicação no
    mesmo URL.
  - **Memória** (`consolidate-memory` implícito): manutenção do arquivo `legacy-heights-site.md` como índice do
    projeto.
- Agentes/subagentes não foram necessários: o projeto exigia contexto contínuo (uma cena, um conjunto de scripts);
  fan-out só faria sentido para buscas amplas, que aqui eram raras.
- Regra de uso: skill quando ela reduz trabalho repetitivo ou impõe um padrão (design de artifact, deploy);
  ferramenta padrão para o resto.

---

## 7. Validação (o que contava como "pronto")

- Export: contagens (casas, lotes, árvores) batem com o Blender; IDs desaparecidos são avisados pelo
  `build_properties.py`.
- Site: sem erros no console, sem 404 na rede, screenshot da vista inicial, teste de clique/painel/filtros e do
  modo noite no preview.
- Backend: `test_backend.py` verde contra a URL publicada; reserva de teste criada e liberada; planilha limpa na entrega.
- Publicação: página pública recarregada com `?v=` novo; artifact republicado e aberto.
- Documentação: README do site e do backend atualizados a cada etapa, memória atualizada com decisões e gotchas.

---

## 8. Checklist para repetir o processo em outro empreendimento

1. Receber o `.blend` (ou `.skp`) e **inspecionar** antes de escrever código.
2. Definir custom properties/IDs estáveis nas instâncias no modelo.
3. Escrever o script de export headless; rodar; corrigir gotchas **no script**.
4. Montar registro de propriedades + rótulos oficiais (PDF) + georreferência + satélite.
5. Site estático three.js com `config.js` centralizando decisões; dev server com mock de backend.
6. Rodadas curtas de refinamento visual com o cliente; capturar câmera/gosto direto do viewer.
7. Backend Apps Script na conta do cliente (com permissão), testes automatizados contra a URL real.
8. Publicar (Pages + single-file), bump de versão, backup tgz, atualizar README e memória.
