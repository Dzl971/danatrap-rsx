from pathlib import Path
import argparse, json, re, shutil, zipfile
SUPPORTED={'.ttf','.otf','.woff','.woff2'}
WEIGHTS={'thin':100,'extralight':200,'ultralight':200,'light':300,'regular':400,'normal':400,'medium':500,'semibold':600,'demibold':600,'bold':700,'extrabold':800,'ultrabold':800,'black':900,'heavy':900}
def clean(value):
 value=re.sub(r'[^0-9A-Za-zÀ-ÿ _.-]+',' ',value).strip(' ._-')
 return re.sub(r'\s+',' ',value) or 'Police'
def family_from(name, fallback):
 stem=Path(name).stem
 stem=re.sub(r'(?i)[-_ ]?(thin|extra.?light|ultra.?light|light|regular|normal|medium|semi.?bold|demi.?bold|bold|extra.?bold|ultra.?bold|black|heavy|italic|oblique).*$', '', stem)
 return clean(stem) or clean(fallback)
def weight_style(name):
 low=Path(name).stem.lower().replace('-','').replace('_','').replace(' ','')
 weight=400
 for key,value in WEIGHTS.items():
  if key in low:weight=value;break
 return weight,('italic' if 'italic' in low or 'oblique' in low else 'normal')
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--project',required=True);args=parser.parse_args();root=Path(args.project).resolve();source=root/'Font';web=root/'frontend/assets/fonts';source.mkdir(parents=True,exist_ok=True);web.mkdir(parents=True,exist_ok=True)
 staging=source/'_extraits';shutil.rmtree(staging,ignore_errors=True);staging.mkdir(parents=True)
 archives=list(source.rglob('*.zip'))
 for archive in archives:
  target=staging/clean(archive.stem);target.mkdir(parents=True,exist_ok=True)
  try:
   with zipfile.ZipFile(archive) as z:
    for info in z.infolist():
     if info.is_dir() or Path(info.filename).suffix.lower() not in SUPPORTED:continue
     out=target/Path(info.filename).name
     with z.open(info) as src,out.open('wb') as dst:shutil.copyfileobj(src,dst)
  except zipfile.BadZipFile:print(f'[IGNORÉ] ZIP invalide : {archive.name}')
 loose=[p for p in source.rglob('*') if p.is_file() and p.suffix.lower() in SUPPORTED and '_extraits' not in p.parts]
 files=list(staging.rglob('*'))+loose
 catalog=[];shutil.rmtree(web,ignore_errors=True);web.mkdir(parents=True)
 for file in files:
  if not file.is_file() or file.suffix.lower() not in SUPPORTED:continue
  fallback=file.parent.name if file.parent!=staging else file.stem;family=family_from(file.name,fallback);ext=file.suffix.lower().lstrip('.').upper();local_dir=source/family/ext;local_dir.mkdir(parents=True,exist_ok=True);local_file=local_dir/file.name
  if file.resolve()!=local_file.resolve():shutil.copy2(file,local_file)
  web_dir=web/clean(family);web_dir.mkdir(parents=True,exist_ok=True);web_file=web_dir/file.name;shutil.copy2(file,web_file);weight,style=weight_style(file.name);catalog.append({'family':family,'file':web_file.relative_to(web).as_posix(),'weight':weight,'style':style,'format':file.suffix.lower().lstrip('.')})
 # dedupe
 unique=[];seen=set()
 for item in catalog:
  key=(item['family'],item['file'])
  if key not in seen:seen.add(key);unique.append(item)
 css=['/* Généré automatiquement. */']
 for item in unique:
  fmt={'ttf':'truetype','otf':'opentype','woff':'woff','woff2':'woff2'}[item['format']]
  css.append("@font-face{font-family:'%s';src:url('./%s') format('%s');font-weight:%s;font-style:%s;font-display:swap}"%(item['family'].replace("'",""),item['file'].replace("'","%27"),fmt,item['weight'],item['style']))
 families=sorted({item['family'] for item in unique},key=str.lower)
 (web/'fonts.css').write_text('\n'.join(css)+'\n',encoding='utf-8');(web/'fonts.js').write_text('window.DRSX_FONTS='+json.dumps(families,ensure_ascii=False)+';\n',encoding='utf-8');(web/'fonts.json').write_text(json.dumps(unique,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');shutil.rmtree(staging,ignore_errors=True)
 print(f'{len(unique)} fichier(s) de police préparé(s), {len(families)} famille(s).')
if __name__=='__main__':main()
