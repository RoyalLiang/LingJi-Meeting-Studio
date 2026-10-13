.DEFAULT_GOAL := dev
WEB_PORT ?= 3000

.PHONY: help install dev web api worker build start

help:
	@printf '%s\n' \
	  'make / make dev  启动 Web、Record API 和后台 worker' \
	  'make install     安装锁定的依赖（npm ci）' \
	  'make web         单独启动前端（--host 0.0.0.0，WEB_PORT 可修改端口）' \
	  'make api         单独启动 Record API' \
	  'make worker      单独启动后台 worker' \
	  'make build       构建 Web' \
	  'make start       启动生产模式（需先构建并配置环境）'

install:
	npm ci

dev:
	./scripts/start.sh

web:
	npm run dev -w apps/web -- --host 0.0.0.0 --port $(WEB_PORT)

api:
	npm run dev:records

worker:
	npm run dev:record-worker

build:
	npm run build:web

start:
	./scripts/start.sh --production
