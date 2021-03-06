local function ctlsub(c)
	if c == "\n" then return "\\n"
	elseif c == "\r" then return "\\r"
	elseif c == "\t" then return "\\t"
	--elseif c == "\\" then return "\\\\"
	--elseif c == "\"" then return "\\\""
	else return string.format("\\%03d", string.byte(c))
	end
end

local function find_class_name(mt)
	for k,v in pairs(_G) do
		if v == mt then
			return k
		end
	end
end

local function pack_pcall(ok, ...)
	return ok, { ... }, select("#", ...)
end

local util = require("jit.util")
local function to_console_string(value)
	local kind = type(value)
	local str
	if kind == "string" then
		if string.find(value, "%c") then
			str = string.gsub(string.format("%q", value), "%c", ctlsub)
		else
			str = value
		end
	elseif kind == "table" then
		local table_kind
		if rawget(value, "___is_class_metatable___") or rawget(value, "__class_name") then
			table_kind = "class"
		else
			local mt = getmetatable(value)
			if type(mt) == "table" then
				table_kind = mt.__class_name or find_class_name(mt) or "<unknown metatable>"
			end
		end
		str = string.format("%s {…}: %p", table_kind or "table", value)
	elseif kind == "function" then
		str = string.format("ƒ (): %p", value)
	elseif kind == "userdata" then
		 -- The LuaJIT file sentinel crashes the Stingray `tostring()` function.
		if string.format("%p", value) == "0x00004004" then
			str = "sentinel"
		else
			str = tostring(value)
		end
	else
		str = string.format("%s", value)
	end
	return str
end
rawset(_G, "to_console_string", to_console_string)

local function resolve_path(value, path)
	for i=1, #path do
		local part = path[i]
		if part == -1 then -- Special pseudo-path.
			value = getmetatable(value)
			goto continue
		end
		local kind = type(value)
		if kind == "function" then
			value = util.funcinfo(value)
		elseif kind ~= "table" then
			return nil
		end
		for _, v in pairs(value) do
			if part == 0 then
				value = v
				goto continue
			end
			part = part - 1
		end
		::continue::
	end
	return value
end

local ffi = require("ffi")
local function table_data(t)
	local addr = string.match(string.format("%p", t), "0x(%x+)")
	assert(addr, "invalid pointer")
	local ptr32 = ffi.cast("uint32_t*", tonumber(addr, 16))
	local ptr8 = ffi.cast("uint8_t*", tonumber(addr, 16))
	return ptr32[6], ptr32[7], ptr8[7]
end

local function format_value(value, name, include_children, is_nested)
	local kind = type(value)
	local children
	if include_children then
		if kind == "table" or kind == "function" then
			children = {}
			local iterationValue = value
			if kind == "function" then
				iterationValue = util.funcinfo(value)
				if iterationValue.addr then
					iterationValue.addr = string.format("%016x", iterationValue.addr)
				end
			end
			for k, v in pairs(iterationValue) do
				children[#children+1] = format_value(v, k)
			end
			if kind == "table" then
				local mt = getmetatable(value)
				if mt ~= nil then
					children[#children+1] = format_value(mt, "(metatable)")
				end
				local asize, hsize, colosize = table_data(value)
				if hsize > 0 then hsize = hsize+1 end
				children[#children+1] = format_value(asize, "(size array)")
				children[#children+1] = format_value(hsize, "(size hash)")
				if colosize ~= 0 then
					children[#children+1] = {
						name = "(colocated)",
						value = colosize > 0 and "yes" or "separated",
						type = "string",
					}
				end
			end
		end
	end
	local value_str
	if not is_nested and kind == "string" then
		value_str = string.gsub(string.format("%q", value), "\\9%f[%D]", "\t")
	end
	return {
		name = to_console_string(name),
		value = value_str or to_console_string(value),
		type = kind,
		children = children,
	}
end

local function make_environment(level)
	level = level + 1
	return setmetatable({}, {
		__index = function(_, target_name)
			local found, target_value = false
			for i=1, 9999 do -- (1) Locals.
				local name, value = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_value = value
				end
			end
			if found then
				return target_value
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					return value
				end
			end
			return rawget(_G, target_name) -- (3) Globals.
		end,
		__newindex = function(_, target_name, target_value)
			local found, target_i = false
			for i=1, 9999 do -- (1) Locals.
				local name = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_i = i
				end
			end
			if found then
				debug.setlocal(level, target_i, target_value)
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					debug.setupvalue(func, i, target_value)
					return
				end
			end
			rawset(_G, target_name, target_value) -- (3) Globals.
		end,
	})
end

local EVAL_COUNT = 0 -- Number of evaluated expressions.
local EVAL_REGISTRY = {}

local handlers = {
	stack = function(request)
		local response = {}
		for i=1, 9999 do
			local info = debug.getinfo(1+i, "nSl")
			if not info then break end
			response[i] = info
		end
		return response
	end,
	locals = function(request)
		local response = {}
		local level = request.level
		for i=1, 1000000000 do
			local name, value = debug.getlocal(level, i)
			if not name then break end
			response[i] = format_value(value, name)
		end
		return response
	end,
	upvals = function(request)
		local func = debug.getinfo(request.level, "f").func
		local response = {}
		for i=1, 1000000000 do
			local name, value = debug.getupvalue(func, i)
			if not name then break end
			response[i] = format_value(value, name)
		end
		return response
	end,
	contents = function(request)
		local _, value
		local id = request.id
		if id > 0 then
			_, value = debug.getlocal(request.level, id)
		else
			_, value = debug.getupvalue(request.level, -id)
		end
		return format_value(resolve_path(value, request.path))
	end,
	eval = function(request)
		-- If a stack level is provided, we have to adjust it skipping all the
		-- debug stuff that is currently on the stack. This is *very* brittle.
		EVAL_COUNT = EVAL_COUNT + 1
		local eval_name = string.format("eval#%d", EVAL_COUNT)
		local thunk = loadstring("return "..request.expression, eval_name)
		if not thunk then
			local err
			thunk, err = loadstring(request.expression, eval_name)
			if not thunk then
				return nil, err
			end
		end
		local environment = request.level and make_environment(request.level + (3+3)) or _G
		setfenv(thunk, environment)
		local completion = request.completion
		local ok, results, num_results = pack_pcall(pcall(thunk))
		if not ok then
			return nil, results[1]
		end
		local response
		if completion or num_results <= 1 then
			response = format_value(results[1], eval_name, true)
			results = results[1]
		else
			local value_buffer = {}
			local children = {}
			for i=1, num_results do
				children[i] = format_value(results[i], "(return#"..i..")")
				value_buffer[i] = children[i].value
			end
			response = {
				name = eval_name,
				value = table.concat(value_buffer, ", "),
				type = "table",
				children = children,
			}
		end
		response.id = #EVAL_REGISTRY+1
		EVAL_REGISTRY[response.id] = results
		return response
	end,
	expandEval = function(request)
		return format_value(resolve_path(EVAL_REGISTRY[request.id], request.path), nil, true, true)
	end,
}

local cjson = stingray.cjson.stingray_init()

local function VSCodeDebugAdapter(str)
	local request = cjson.decode(str)
	local ok, result, force_error = pcall(handlers[request.request_type], request)
	if force_error then
		ok, result = nil, force_error
	end
	stingray.Application.console_send({
		type = "vscode_debug_adapter",
		request_id = request.request_id,
		request_type = request.request_type,
		result = result,
		ok = ok,
	})
end

rawset(_G, "VSCodeDebugAdapter", VSCodeDebugAdapter)

stingray.Application.console_send({
	type = "vscode_debug_adapter",
	request_id = "inject",
	request_type = "inject",
	result = true,
	ok = true,
})
