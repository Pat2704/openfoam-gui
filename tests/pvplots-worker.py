"""Exercise production numeric extraction with local ParaView and disposable fixtures."""
import ast
import json
import math
import sys
from pathlib import Path
from collections import OrderedDict
from paraview.simple import *
from vtkmodules.vtkCommonCore import vtkDoubleArray, vtkPoints, vtkStringArray
from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData, vtkMultiBlockDataSet, vtkTable

source = (Path(__file__).parents[1] / 'src/lib/paraview.ts').read_text(encoding='utf-8')
worker = source.split('const WORKER_SCRIPT = String.raw`', 1)[1].split('\n`;', 1)[0]
functions = ast.Module(body=[node for node in ast.parse(worker).body if isinstance(node, ast.FunctionDef)], type_ignores=[])
namespace = dict(globals())
exec(compile(functions, 'workbench-worker.py', 'exec'), namespace)
namespace.update({'nodes': OrderedDict(), 'selected_id': 'reader', 'current_time': 0.0, 'data_revision': 7})

def array(name, values, components=1):
    result = vtkDoubleArray()
    result.SetName(name)
    result.SetNumberOfComponents(components)
    for value in values:
        if components == 1: result.InsertNextValue(value)
        else: result.InsertNextTuple(value)
    return result

def select(output):
    proxy = TrivialProducer()
    proxy.GetClientSideObject().SetOutput(output)
    namespace['nodes']['reader'] = {'proxy': proxy}
    return proxy

def request(mode='page', **fields):
    return namespace['data_table']({'id': 'reader', 'revision': 7, 'time': 0.0, 'mode': mode, **fields})

def column(data, name, component=0):
    return next(item['index'] for item in data['columns'] if item['name'] == name and item['component'] == component)

def rejects(**fields):
    try: request(**fields)
    except RuntimeError: return
    raise AssertionError('Request should have failed: ' + str(fields))

points = vtkPoints()
for index in range(5): points.InsertNextPoint(index, index * 2, 0)
poly = vtkPolyData(); poly.SetPoints(points)
poly.GetPointData().AddArray(array('U', [(3, 4, 0), (6, 8, 0), (1, 2, 3), (math.nan, 1, 2), (1e308, 1e308, 0)], 3))
poly.GetPointData().AddArray(array('arc_length', range(5)))
poly.GetPointData().AddArray(array('vtkValidPointMask', [1, 1, 0, 1, 1]))
select(poly)
schema = request('schema')
assert schema['totalRows'] == 5 and not schema['rows'] and schema['association'] == 'POINTS'
data = request(columns=[column(schema, 'arc_length'), column(schema, 'U', -1), column(schema, 'Coordinate X')])
assert data['rows'][0] == [0, 5, 0] and data['rows'][1] == [1, 10, 1]
assert data['rows'][2] == [2, None, 2] and data['invalidRows'] == 1
assert data['rows'][3][1] is None and data['nonFiniteValues'] == 1
assert math.isclose(data['rows'][4][1], math.hypot(1e308, 1e308))
json.dumps(data, allow_nan=False)
print('PASS native points/components/magnitude/mask/nonfinite/large finite values', flush=True)
for fields in ({'revision': 8}, {'id': 'other'}, {'time': 1}, {'columns': [128]}, {'columns': [-1]},
               {'columns': [True]}, {'columns': []}, {'association': 'ROWS'}, {'block': 99}, {'mode': 'python'}):
    rejects(**fields)
print('PASS explicit allowlist and revision/selection/time checks', flush=True)

composite = vtkMultiBlockDataSet(); composite.SetBlock(0, poly); composite.SetBlock(1, poly)
select(composite); schema = request('schema')
assert len(schema['blocks']) == 2 and schema['totalRows'] == 5
second = request(block=schema['blocks'][1]['index'])
assert second['block'] != schema['block'] and len(second['rows']) == 5
print('PASS leaf composite blocks stay separate', flush=True)

cells = vtkPolyData(); cells.SetPoints(points)
vertices = vtkCellArray()
for index in range(5): vertices.InsertNextCell(1); vertices.InsertCellPoint(index)
cells.SetVerts(vertices); cells.GetCellData().AddArray(array('p', range(5)))
select(cells); schema = request('schema'); assert schema['association'] == 'CELLS' and schema['totalRows'] == 5
assert request(association='CELLS', columns=[column(schema, 'p')])['rows'] == [[0], [1], [2], [3], [4]]
assert request('schema', association='POINTS')['association'] == 'POINTS'
print('PASS cell values and automatic association respect explicit point choice', flush=True)

table = vtkTable(); table.AddColumn(array('time', range(201))); table.AddColumn(array('value', [math.nan] + list(range(200))))
text = vtkStringArray(); text.SetName('label'); text.SetNumberOfValues(201); table.AddColumn(text)
select(table); schema = request('schema'); data = request()
assert schema['association'] == 'ROWS' and schema['nonNumericColumns'] == 1
assert len(data['rows']) == 200 and data['limited'] and request(offset=200)['rows'][0][0] == 200
assert request('export')['rows'][0][-1] is None
print('PASS vtkTable numeric metadata, page and export gaps', flush=True)

big = vtkTable(); values = array('value', range(200001)); big.AddColumn(values); select(big)
data = request('chart', columns=[1]); assert len(data['rows']) == 20000 and data['limited']
data = request('export', columns=[1]); assert len(data['rows']) == 200000 and data['limited']
print('PASS native chart/export row caps', flush=True)

wide = vtkTable()
for index in range(16):
    values = vtkDoubleArray(); values.SetName('value' + str(index)); values.SetNumberOfTuples(200001); values.FillComponent(0, 1)
    wide.AddColumn(values)
select(wide); data = request('export', columns=list(range(1, 17)))
assert 50000 < len(data['rows']) <= 62500 and data['rowLimit'] == 62500 and data['limited']
huge = vtkTable()
for index in range(16):
    values = vtkDoubleArray(); values.SetName('huge' + str(index)); values.SetNumberOfTuples(200001); values.FillComponent(0, 1.1234567890123456e308)
    huge.AddColumn(values)
select(huge); data = request('export', columns=list(range(1, 17)))
assert len(data['rows']) < data['rowLimit'] and data['limited']
assert len(json.dumps(data['rows'], separators=(',', ':'))) < 4200000
print('PASS one-million value and 4 MB prefix export budgets', flush=True)

wavelet = Wavelet(); wavelet.UpdatePipeline()
line = PlotOverLine(Input=wavelet); line.Point1 = [-15, 0, 0]; line.Point2 = [15, 0, 0]; line.Resolution = 30
namespace['nodes']['reader'] = {'proxy': line}; schema = request('schema')
data = request('chart', columns=[column(schema, 'arc_length'), column(schema, 'RTData')])
assert data['rows'][0][0] == 0 and data['rows'][0][1] is None and data['rows'][-1][1] is None
assert data['invalidRows'] > 0 and any(row[1] is not None for row in data['rows'])
print('PASS actual PlotOverLine preserves arc length and invalid samples', flush=True)

if len(sys.argv) > 1:
    marker = Path(sys.argv[1]); assert marker.parent.name == 'test' or marker.parent.name.endswith('_test')
    reader = OpenFOAMReader(FileName=str(marker)); namespace['set_if_supported'](reader, 'SkipZeroTime', 0)
    reader.UpdatePipelineInformation()
    for property_name in ('CellArrays', 'PointArrays'):
        available = namespace['available_values'](reader, property_name)
        if available: namespace['set_if_supported'](reader, property_name, available)
    times = list(reader.TimestepValues); assert len(times) >= 2
    namespace['current_time'] = float(times[-1]); namespace['nodes']['reader'] = {'proxy': reader}
    schema = namespace['data_table']({'id': 'reader', 'revision': 7, 'time': float(times[-1]), 'mode': 'schema'})
    assert len(schema['blocks']) >= 1 and schema['totalRows'] > 0
    line = PlotOverLine(Input=reader); line.Point1 = [0.01, 0.05, 0.005]; line.Point2 = [0.09, 0.05, 0.005]; line.Resolution = 20
    namespace['nodes']['reader'] = {'proxy': line}
    schema = namespace['data_table']({'id': 'reader', 'revision': 7, 'time': float(times[-1]), 'mode': 'schema'})
    data = namespace['data_table']({'id': 'reader', 'revision': 7, 'time': float(times[-1]), 'mode': 'chart',
                                  'columns': [column(schema, 'arc_length'), column(schema, 'U', -1)]})
    assert data['rows'] and any(row[1] is not None for row in data['rows'])
    csv = marker.parent / 'comparison.csv'
    if csv.exists():
        reader = CSVReader(FileName=[str(csv)]); namespace['nodes']['reader'] = {'proxy': reader}
        data = namespace['data_table']({'id': 'reader', 'revision': 7, 'time': float(times[-1]), 'mode': 'page'})
        assert data['association'] == 'ROWS' and data['totalRows'] == 5
    print('PASS disposable OpenFOAM reader, sampled U and case-local CSV table', flush=True)
