"""Run the workbench's real display code against an external pvpython.

Uses synthetic fields in a disposable _test directory. Pass an OpenFOAM
marker as the optional argument to repeat the checks on a disposable case.
"""

import ast
import math
import os
from pathlib import Path
import sys
import tempfile
from collections import OrderedDict
from paraview.simple import *


source = (Path(__file__).parents[1] / 'src/lib/paraview.ts').read_text(encoding='utf-8')
worker = source.split('const WORKER_SCRIPT = String.raw`', 1)[1].split('\n`;', 1)[0]
tree = ast.parse(worker)
# Execute the production functions, without the process protocol or startup.
functions = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef)], type_ignores=[])
namespace = dict(globals())
exec(compile(functions, 'workbench-worker.py', 'exec'), namespace)


def check(label, expected):
    namespace['state']()
    actual = {name: bool(GetScalarBar(GetColorTransferFunction(name), namespace['view']).Visibility) for name in expected}
    assert actual == expected, (label, actual, expected)
    print('PASS ' + label, flush=True)


def color(identifier, name, legend=True):
    namespace['selected_id'] = identifier
    namespace['update_selected']({'color': {'association': 'POINTS', 'name': name, 'legend': legend, 'preset': ''}})


with tempfile.TemporaryDirectory(prefix='ofstudio-paraview-legends-', suffix='_test') as temporary:
    marker = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(temporary) / 'synthetic.foam'
    if len(sys.argv) > 1:
        assert marker.parent.name == 'test' or marker.parent.name.endswith('_test'), 'Only disposable cases may be used.'
        foam = OpenFOAMReader(FileName=str(marker))
        namespace['set_if_supported'](foam, 'SkipZeroTime', 0)
        namespace['set_if_supported'](foam, 'ReadAllFilesToDetermineStructure', 1)
        foam.UpdatePipelineInformation()
        for property_name in ('CellArrays', 'PointArrays'):
            values = namespace['available_values'](foam, property_name)
            if values: namespace['set_if_supported'](foam, property_name, values)
        raw_times = [float(v) for v in list(foam.TimestepValues)]
        foam.UpdatePipeline(time=raw_times[-1] if raw_times else 0)
        upstream = CellDatatoPointData(Input=foam)
        upstream.UpdatePipeline(time=raw_times[-1] if raw_times else 0)
        arrays = namespace['arrays_for'](upstream)
        scalars = [a['name'] for a in arrays if a['association'] == 'POINTS' and a['components'] == 1]
        assert scalars, ('The disposable case needs a scalar field.', raw_times,
                         namespace['property_value'](foam, 'MeshRegions', []), arrays)
        chosen = scalars[0]
    else:
        upstream = Wavelet()
        raw_times = [0.0, 1.0]
        chosen = 'RTData'
    reader = Calculator(Input=upstream)
    reader.Function = chosen + ' * 2'
    reader.ResultArrayName = 'legend_test_other'
    reader.UpdatePipeline(time=raw_times[-1] if raw_times else 0)
    view = CreateRenderView()
    view.ViewSize = [320, 240]
    namespace.update({
        'reader': reader, 'view': view, 'scene': GetAnimationScene(),
        'nodes': OrderedDict(), 'guides': {}, 'legend_bars': {},
        'selected_id': 'reader', 'next_filter': 1, 'current_time': raw_times[-1] if raw_times else 0,
        'times': raw_times or [0.0], 'raw_times': raw_times, 'case_name': marker.parent.name,
        'marker': str(marker), 'output_dir': temporary, 'pv_version': 'test',
        'background_name': 'White', 'BACKGROUNDS': {'White': [1, 1, 1]},
        'available_presets': [], 'supported_video_formats': [], 'manipulator_visible': False,
        'DISPLAY_REPRESENTATIONS': ('Surface', 'Surface With Edges', 'Wireframe', 'Feature Edges', 'Points', 'Outline'),
        'FILTER_LABELS': {'Slice': 'Slice'},
    })
    root = {
        'proxy': reader, 'display': Show(reader, view), 'label': 'reader', 'type': 'OpenFOAMReader',
        'parent': None, 'visible': True, 'representation': 'Surface',
        'opacity': 1, 'lineWidth': 1, 'pointSize': 3,
        'color': {'association': 'SOLID', 'name': '', 'preset': '', 'legend': False},
    }
    namespace['nodes']['reader'] = root
    color('reader', chosen)
    check('first legend', {chosen: True})
    assert GetScalarBar(GetColorTransferFunction(chosen), view).Title == chosen, 'The legend keeps its field title.'
    color('reader', 'legend_test_other')
    check('recolor removes old legend', {chosen: False, 'legend_test_other': True})
    color('reader', chosen)
    branch = Slice(Input=reader)
    identifier = namespace['register_filter']('Slice', branch, 'reader', hide_parent=False)
    color(identifier, chosen, False)
    check('legend-off sibling preserves shared legend', {chosen: True, 'legend_test_other': False})
    color(identifier, chosen)
    namespace['selected_id'] = 'reader'
    namespace['update_selected']({'color': {'association': 'SOLID', 'name': '', 'legend': False}})
    check('solid sibling preserves shared legend', {chosen: True, 'legend_test_other': False})
    color('reader', 'legend_test_other')
    check('recolor preserves another node using old LUT', {chosen: True, 'legend_test_other': True})
    namespace['nodes'][identifier]['visible'] = False
    namespace['apply_display'](namespace['nodes'][identifier])
    check('hidden node removes unneeded legend', {chosen: False, 'legend_test_other': True})
    namespace['nodes'][identifier]['visible'] = True
    namespace['apply_display'](namespace['nodes'][identifier])
    check('show restores requested legend', {chosen: True, 'legend_test_other': True})
    snapshot = namespace['prepare_snapshot'](namespace['capture_view']())
    color(identifier, 'legend_test_other', False)
    check('shared legend ignores last node legend flag', {chosen: False, 'legend_test_other': True})
    namespace['apply_snapshot'](snapshot, True)
    check('video snapshot restores both legends', {chosen: True, 'legend_test_other': True})
    namespace['selected_id'] = identifier
    namespace['delete_selected']()
    check('delete removes orphan legend', {chosen: False, 'legend_test_other': True})
    color('reader', chosen)
    namespace['set_time'](namespace['times'][0])
    check('time update preserves only requested legend', {chosen: True, 'legend_test_other': False})
    reader.ResultArrayName = 'legend_test_changed'
    reader.UpdatePipeline()
    root['color']['name'] = 'legend_test_other'
    namespace['apply_display'](root)
    check('missing array removes legend after reader update', {chosen: False, 'legend_test_other': False})
    root['color'] = {'association': 'SOLID', 'name': '', 'legend': False, 'preset': ''}
    namespace['apply_display'](root)
    namespace['render'](1, 320, 240)
    check('solid color render removes scalar legends', {chosen: False, 'legend_test_other': False})
