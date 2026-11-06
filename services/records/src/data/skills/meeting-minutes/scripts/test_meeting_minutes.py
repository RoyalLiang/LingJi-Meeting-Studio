#!/usr/bin/env python3
"""Offline behavioral checks; never contacts a Feishu tenant."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import feishu_board_drawer as board


ROOT = Path(__file__).resolve().parents[1]


class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return json.dumps(self.value).encode()


class BotIdentityTests(unittest.TestCase):
    def client(self):
        client = board.FeishuBoardClient(app_id='cli_test', app_secret='test-secret')
        client._throttle = lambda: None
        return client

    def test_requires_both_credentials_and_ignores_user_token(self):
        with patch.dict(os.environ, {'FEISHU_ACCESS_TOKEN':'personal-token'}, clear=True), patch.object(board.urllib.request, 'urlopen') as net:
            with self.assertRaises(ValueError): board.FeishuBoardClient()
            with self.assertRaises(ValueError): board.FeishuBoardClient(app_id='cli_test')
            net.assert_not_called()

    def test_bot_auth_and_expiry_refresh(self):
        requests = []
        replies = [dict(code=0, tenant_access_token='tenant-one', expire=7200), dict(code=0, data={}),
                   dict(code=0, tenant_access_token='tenant-two', expire=7200), dict(code=0, data={})]
        def send(req, **kwargs): requests.append(req); return Response(replies.pop(0))
        client = self.client()
        with patch.object(board.urllib.request, 'urlopen', side_effect=send):
            client._request('POST', '/open-apis/docx/v1/documents', {'title':'会议'})
            client._token_deadline = 0
            client._request('POST', '/open-apis/docx/v1/documents', {'title':'会议'})
        self.assertIsNone(requests[0].get_header('Authorization'))
        self.assertEqual(json.loads(requests[0].data), {'app_id':'cli_test','app_secret':'test-secret'})
        self.assertEqual(requests[1].get_header('Authorization'), 'Bearer tenant-one')
        self.assertEqual(requests[3].get_header('Authorization'), 'Bearer tenant-two')

    def test_business_error_is_failure_and_secret_is_redacted(self):
        client = self.client()
        with patch.object(board.urllib.request, 'urlopen', return_value=Response(dict(code=999,msg='bad test-secret'))):
            with self.assertRaises(RuntimeError) as error: client.authenticate()
        self.assertNotIn('test-secret', str(error.exception))
        self.assertIn('999', str(error.exception))

    def test_429_retries_but_5xx_does_not_replay_write(self):
        client = self.client(); client.access_token='tenant'; client._token_deadline=float('inf')
        limited = urllib.error.HTTPError('https://open.feishu.cn',429,'limit',{},None)
        with patch.object(board.urllib.request, 'urlopen', side_effect=[limited,Response(dict(code=0,data={}))]) as net, patch.object(board.time,'sleep'):
            client._request('POST','/open-apis/docx/v1/documents',{})
            self.assertEqual(net.call_count,2)
        failed = urllib.error.HTTPError('https://open.feishu.cn',503,'failed',{},None)
        with patch.object(board.urllib.request,'urlopen',side_effect=failed) as net:
            with self.assertRaises(RuntimeError): client._request('POST','/open-apis/docx/v1/documents',{})
            self.assertEqual(net.call_count,1)

    def test_connected_nodes_are_one_request(self):
        nodes = board.layout_card_to_board_nodes({'type':'flow','steps':[{'t':str(i)} for i in range(25)]})[0]
        client=self.client()
        with patch.object(client,'_request',return_value={'code':0}) as req:
            client.draw_nodes_on_board('board',nodes)
            self.assertEqual(req.call_count,1)
            self.assertEqual(len(req.call_args.args[2]['nodes']),len(nodes))
        with patch.object(client,'_request') as req:
            with self.assertRaises(ValueError): client.draw_nodes_on_board('board',[nodes[0]]*3001)
            req.assert_not_called()

    def test_document_chunks_and_missing_board_token(self):
        client=self.client(); sizes=[]
        def create(method,path,body):
            if path.endswith('/blocks/existing/children'):
                sizes.append(len(body['children']))
                return {'code':0,'data':{'children':[{'block_id':str(i)} for i in range(len(body['children']))]}}
            return {'code':0,'data':{}}
        with patch.object(client,'_request',side_effect=create), contextlib.redirect_stderr(io.StringIO()):
            client.create_docx_with_embedded_boards({'sections':[{'items':['note']*105}]},document_id='existing')
        self.assertEqual(sizes,[50,50,6])
        with patch.object(client,'_request',side_effect=create), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError,'Missing board token'):
                client.create_docx_with_embedded_boards({'sections':[{'items':[{'type':'grid','items':[]}]}]},document_id='existing')


class LayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=json.loads((ROOT/'examples/sample-feishu-screenshot.json').read_text())
        cls.cards=[item for sec in cls.data['sections'] for item in sec['items'] if isinstance(item,dict)]

    def assert_geometry(self,nodes,width,height,ox=0,oy=0):
        shapes=[n for n in nodes if n['type']=='composite_shape']
        ids=[n['id'] for n in nodes]; self.assertEqual(len(ids),len(set(ids)))
        content=[]
        for n in shapes:
            self.assertGreater(n['width'],0);self.assertGreater(n['height'],0)
            self.assertGreaterEqual(n['x'],ox);self.assertGreaterEqual(n['y'],oy)
            self.assertLessEqual(n['x']+n['width'],ox+width+.2)
            self.assertLessEqual(n['y']+n['height'],oy+height+.2)
            t=n.get('text',{})
            if t.get('content'):
                self.assertGreaterEqual(n['height']+.1,len(t['_wrapped_lines'])*t['font_size']*1.42+23)
                content.append(n)
        for i,a in enumerate(content):
            for b in content[i+1:]:
                overlap_x=min(a['x']+a['width'],b['x']+b['width'])-max(a['x'],b['x'])
                overlap_y=min(a['y']+a['height'],b['y']+b['height'])-max(a['y'],b['y'])
                self.assertFalse(overlap_x>.2 and overlap_y>.2,(a['id'],b['id']))

    def test_all_twelve_card_types_and_native_contract(self):
        self.assertEqual(len({c['type'] for c in self.cards}),12)
        for index,card in enumerate(self.cards):
            with self.subTest(kind=card['type']):
                nodes,w,h,_=board.layout_card_to_board_nodes(card,13,17,f'card{index}')
                self.assert_geometry(nodes,w,h,13,17)
                clean=board.strip_internal_keys(nodes)
                self.assertEqual(clean,board.strip_internal_keys(clean))
                by_id={n['id']:n for n in clean}
                for n in clean:
                    self.assertIsInstance(n['style']['border_width'],str)
                    if n['type']=='composite_shape':
                        t=n['text'];self.assertNotIn('content',t);self.assertNotIn('_wrapped_lines',t)
                        self.assertEqual(t['vertical_align'],'mid');self.assertIn(t['font_weight'],('regular','bold'))
                        self.assertIn(t['text_color'],('#1F2329','#5178C6'))
                    elif n['type']=='connector':
                        self.assertNotIn('start_object',n)
                        for end in ('start','end'):
                            ref=n['connector'][end]['attached_object']
                            self.assertIn(ref['id'],by_id);self.assertIn(ref['snap_to'],('left','right','top','bottom'))

    def test_long_chinese_and_wrapped_flow_preserve_content(self):
        text='跨团队长中文描述与极端情况'+('测试文字'*40)+' @陈杰 79.6% 11-07'
        card={'type':'flow','title':text,'steps':[{'t':text,'d':text,'s':'active'} for _ in range(17)]}
        nodes,w,h,_=board.layout_card_to_board_nodes(card)
        self.assert_geometry(nodes,w,h)
        texts=[''.join(n.get('text',{}).get('_wrapped_lines',[])).replace(' ','') for n in nodes]
        self.assertIn(text.replace(' ',''),texts)
        self.assertEqual(sum(text.replace(' ','') in t for t in texts),18)

    def test_summary_and_every_section_are_in_full_board(self):
        result=board.compile_full_meeting_whiteboard(self.data)
        raw=''.join(n.get('text',{}).get('content','').replace('\n','') for n in result['full_whiteboard_payload']['nodes'])
        self.assertIn(self.data['summary'],raw)
        for sec in self.data['sections']: self.assertIn(sec['title'],raw)
        canvas=result['meta']['canvas'];self.assert_geometry(result['full_whiteboard_payload']['nodes'],canvas['width'],canvas['height'])

    def test_local_cli_needs_no_credentials_remote_cli_fails_closed(self):
        env={k:v for k,v in os.environ.items() if not k.startswith('FEISHU_')};env['PYTHONDONTWRITEBYTECODE']='1'
        with tempfile.TemporaryDirectory() as temp:
            cmd=[sys.executable,str(ROOT/'scripts/feishu_board_drawer.py'),str(ROOT/'examples/sample-feishu-screenshot.json'),'-o',str(Path(temp)/'out.json')]
            local=subprocess.run(cmd,env=env,capture_output=True,text=True)
            self.assertEqual(local.returncode,0,local.stderr)
            remote=subprocess.run(cmd+['--create-docx'],env=env,capture_output=True,text=True)
            self.assertNotEqual(remote.returncode,0);self.assertIn('App Secret',remote.stderr)

    def test_compiler_cli_generates_readable_artifacts_without_false_source_claim(self):
        env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        with tempfile.TemporaryDirectory() as temp:
            dest=Path(temp)
            result=subprocess.run([sys.executable,str(ROOT/'scripts/compile_minutes.py'),
                str(ROOT/'examples/sample-feishu-screenshot.json'),'-o',str(dest/'minutes.html'),
                '--md',str(dest/'minutes.md'),'--board',str(dest/'board.json')],
                env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            html=(dest/'minutes.html').read_text()
            self.assertIn('未对照原文',html)
            self.assertIn('<svg',html)
            self.assertIn(self.data['summary'],(dest/'minutes.md').read_text())
            payload=json.loads((dest/'board.json').read_text())
            self.assertEqual(payload['meta']['total_embedded_boards'],len(self.cards))


if __name__=='__main__': unittest.main(verbosity=2)
