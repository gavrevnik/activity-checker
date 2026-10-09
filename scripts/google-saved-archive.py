"""Bounded Google saved-list parser. No extraction, paths, network or credentials."""
import csv, io, json, posixpath, stat, sys, zipfile
MAX = 50 * 1024 * 1024
csv.field_size_limit(10000)
items = []
def add(item):
    if len(items) >= 20000: raise ValueError('Item limit')
    for key in ['collection','description','title','note','url','comment','address']:
        item.setdefault(key, '')
        if not isinstance(item[key], str) or len(item[key]) > 10000: raise ValueError('Field limit')
    item.setdefault('tags', [])
    item.setdefault('latitude', None); item.setdefault('longitude', None)
    if item['title'] or item['url']: items.append(item)
def parse_csv(data, name):
    rows = list(csv.reader(io.StringIO(data.decode('utf-8-sig'))))
    def key(s): return s.strip().lower().replace(' ', '_')
    header = next((i for i,r in enumerate(rows[:20]) if 'title' in [key(x) for x in r] and any(key(x) in ['url','item_content_url'] for x in r)), None)
    if header is None: return
    description = '\n'.join(','.join(r) for r in rows[:header] if r)
    names = [key(x) for x in rows[header]]
    for row in rows[header+1:]:
        if not row or not any(row): continue
        if len(row) != len(names): raise ValueError('Malformed CSV row')
        r = dict(zip(names,row))
        add(dict(collection=posixpath.basename(name).rsplit('.',1)[0],description=description,title=r.get('title',''),note=r.get('note',''),url=r.get('item_content_url',r.get('url','')),tags=[t.strip() for t in r.get('tags','').split(';') if t.strip()],comment=r.get('comment','')))
def parse_json(data, name):
    doc = json.loads(data.decode('utf-8-sig'))
    if not isinstance(doc,dict) or not isinstance(doc.get('features'),list): return
    for f in doc['features']:
        p=f.get('properties', f.get('property',{})); loc=p.get('Location',p.get('location',{}))
        coords=f.get('geometry',{}).get('coordinates')
        lat=lon=None
        if isinstance(coords,list) and len(coords)>=2: lon,lat=coords[:2]
        elif isinstance(coords,dict):lat=coords.get('latitude');lon=coords.get('longitude')
        add(dict(collection=posixpath.basename(name).rsplit('.',1)[0],description='',title=p.get('Title',p.get('title',p.get('name',loc.get('Business Name','')))),note=p.get('note',''),url=p.get('Google Maps URL',p.get('url','')),tags=[],comment=p.get('comment',''),address=p.get('address',loc.get('Address','')),latitude=lat,longitude=lon))
def parse(data,name):
    if name.lower().endswith('.csv'):parse_csv(data,name)
    elif name.lower().endswith('.json'):parse_json(data,name)
def main():
    raw=sys.stdin.buffer.read(MAX+1)
    if len(raw)>MAX:raise ValueError('Archive limit')
    if sys.argv[1]=='zip':
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            infos=z.infolist()
            if len(infos)>5000:raise ValueError('File count')
            total=0
            for i in infos:
                parts=i.filename.replace('\\','/').split('/')
                if i.filename.startswith('/') or '..' in parts or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits & 1: raise ValueError('Unsafe entry')
                if i.is_dir() or not i.filename.lower().endswith(('.csv','.json')):continue
                total+=i.file_size
                if total>MAX or i.file_size>10*1024*1024 or i.file_size/max(i.compress_size,1)>200:raise ValueError('Expansion limit')
                with z.open(i) as f:
                    b=f.read(10*1024*1024+1)
                    if len(b)>10*1024*1024:raise ValueError('File limit')
                    parse(b,i.filename)
    else:parse(raw,sys.argv[2])
    if not items:raise ValueError('No saved lists found')
    sys.stdout.write(json.dumps(items,ensure_ascii=False))
if __name__=='__main__':
    try:main()
    except Exception:sys.exit(2)
