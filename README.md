# Mapas corporales · NyPE

Actividad web estática para clase, inspirada en el trabajo de mapas corporales de emociones.

## Qué incluye
- Flujo breve para estudiantes con estética similar a las apps `stroop` y `azar`.
- Dos emociones iniciales: `enojo` y `tristeza`.
- Dos mapas por emoción:
  - `activation`: zonas que se sienten más activas, intensas o encendidas.
  - `deactivation`: zonas que se sienten más débiles, apagadas o lentas.
- Pintura binaria: pintado/no pintado, sin intensidad individual.
- Herramientas: pintar, borrar, deshacer, limpiar y tamaño de trazo.
- Guardado en Supabase en la tabla `emotion_map_responses`.
- Heatmaps colectivos por clase y emoción: activación y debilitamiento se combinan en una misma silueta con colores cálidos/fríos.
- `admin.html` para ver mapas colectivos, tabla de registros y exportar CSV.

## Supabase
La app usa el mismo proyecto Supabase que las otras apps de la materia y una tabla nueva:

```sql
create table emotion_map_responses (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  participant_id text not null default 'Anónimo',
  session_id text not null,
  class_id text not null default 'default',
  emotion text not null,
  map_type text not null check (map_type in ('activation', 'deactivation')),
  mask_bits_b64 text not null,
  store_width integer not null,
  store_height integer not null,
  painted_pixels integer not null default 0,
  no_change boolean not null default false,
  body_mask_version text not null default 'paper_ref_v1'
);

alter table emotion_map_responses enable row level security;

create policy "Allow public inserts"
on emotion_map_responses
for insert
to anon
with check (true);

create policy "Allow public reads for collective heatmaps"
on emotion_map_responses
for select
to anon
using (true);
```

## Cómo correr
1. Abrir esta carpeta en VS Code.
2. Levantar Live Server o un servidor estático.
3. Abrir `index.html`.

También se puede separar clases con query string:

```text
index.html?class=nype-2026-clase1
admin.html?class=nype-2026-clase1
```

## Datos
Cada respuesta se guarda como bitset binario en `mask_bits_b64`, con resolución interna `120 x 207`. Los heatmaps colectivos se reconstruyen en el navegador calculando, para cada píxel, la proporción de participantes que lo pintó como activado menos la proporción que lo pintó como debilitado.
