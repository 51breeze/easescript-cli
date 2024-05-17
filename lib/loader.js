const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const {makeTyping} = require('./make');
const Lang = require('easescript/lib/core/Lang');
const Diagnostic = require('easescript/lib/core/Diagnostic');
const {reportDiagnosticMessage} = require('easescript/lib/core/Utils');
const mime = require('mime-types');
const {createHash} = require('crypto');

function parseResource(id) {
    const [resourcePath, rawQuery] = id.split(`?`, 2);
    const query = Object.fromEntries(new URLSearchParams(rawQuery));
    return {
        resourcePath,
        resource:id,
        query
    };
}

function transformError(error){
    let text = '';
    let location = null;
    if(error instanceof Diagnostic) {
        text = error.message;
        location = {
            file:error.file,
            line:error.range.start.line,
            column:error.range.start.column, 
            lineText:'Error code: '+error.code,
            namespace:'file'
        };
    }else if( error && error.text ){
        text = error.text;
        location = error.location || null;
    }else{
       text = String(error); 
    }
    return {
        text,
        location
    }
}

const stylePreprocess = {};
const allowPreprocessLangs =['less', 'sass','scss','styl','stylus'];

function tryRequire(name){
    try{
        const resolevPath = require.resolve(name, {paths:[
            path.join(process.cwd(), 'node_modules'),
            process.cwd(), 
            path.join(__dirname,'../../')
        ]});
        if(resolevPath){
            return require(resolevPath);
        }
    }catch(e){}
}

function createPreprocess(){
    const compiler = tryRequire('@vue/compiler-sfc')
    if(!compiler)return;
    const { getPostCssConfig } = tryRequire('@ckeditor/ckeditor5-dev-utils/lib/styles') || {};
    async function transformStyle({
        filename,
        source,
        scopeId,
        isProd,
        sourcemap,
        preprocessLang='scss',
        preprocessOptions={},
        postcssOptions = {},
        postcssPlugins = []
    }){
        return await compiler.compileStyleAsync({
          source:String(source),
          filename,
          id:scopeId || '',
          scoped:!!scopeId,
          isProd,
          inMap:sourcemap,
          preprocessLang,
          preprocessOptions,
          postcssOptions,
          postcssPlugins
        });
    }

    stylePreprocess.css =  async (args)=>{
        if(args.filename && /[\\\/]@ckeditor[\\\/]ckeditor5/.test(args.filename) ){
            args.preprocessLang = null;
            if(getPostCssConfig && typeof getPostCssConfig === 'function'){
                const postoptions = getPostCssConfig({
                    themeImporter: {
                        themePath:require.resolve('@ckeditor/ckeditor5-theme-lark')
                    }
                });
                args.postcssPlugins = postoptions.plugins || [];
            }
            return await transformStyle(args);
        }
        return {
            code:args.source,
            sourcemap:args.sourcemap
        }
    }

    stylePreprocess.transform = async (args)=>{
        args.preprocessOptions = {
            includePaths:[
                path.join(process.cwd(),'node_modules')
            ]
        }
        args.preprocessLang = null;
        if(allowPreprocessLangs.includes(args.lang)){
            args.preprocessLang = args.lang;
        }
        const result = await transformStyle(args);
        if( result.errors.length>0 ){
            console.error( result.errors, args.filename, result.dependencies)
        }
        return result;
    }
}


async function scssCompile(file, code, emitSourceMap=false){
    const sass = require('sass');
    const result =  await sass.compileStringAsync(String(code));
    let contents = result.css;
    if(emitSourceMap && result.sourceMap){
        contents += '\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(result.sourceMap)).toString('base64');
    }
    return {
        contents,
        loader:'css',
        errors:[]
    }
}

async function lessCompile(file, code, emitSourceMap){
    const less = require('less');
    const options = {filename:file};
    const result = await less.render(String(code),options);
    let contents = result.css;
    if(emitSourceMap && result.map){
        contents += '\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(result.map).toString('base64');
    }
    return {
        contents,
        loader:'css',
        errors:[]
    }
}

const vueRecords = new Map();
async function vueCompile(vueCompiler, resourcePath, relativePath, content, query={}, sourceMap=false){

    let {descriptor, hashId, hasScoped} = vueRecords.has(resourcePath) ? vueRecords.get(resourcePath) : {};
    let contents = content;
    let map = null;

    if(!descriptor){
       let sfc = vueCompiler.parse(content);
       descriptor = sfc.descriptor;
       hasScoped = descriptor.styles.some((s) => s.scoped);
       hashId = createHash("sha256").update(`${resourcePath}`).digest("hex").substring(0, 8);
       vueRecords.set(resourcePath, {descriptor, hashId, hasScoped});
    }

    if(query.type==='template'){
        if(descriptor.template){
            const result = vueCompiler.compileTemplate({
                source: descriptor.template.content,
                filename: resourcePath,
                id:hashId,
                scoped: hasScoped,
                isProd: process.env.NODE_ENV === "production",
                slotted: descriptor.slotted,
                preprocessLang: descriptor.template.lang,
                compilerOptions: {
                scopeId: hasScoped ? `data-v-${hashId}` : void 0,
                sourceMap: sourceMap
                }
            });
            contents = result.code;
            map = result.map;
        }
    }else if(query.type==='style'){
        if (descriptor.styles.length > 0) {
            const codes = [];
            for (const style of descriptor.styles) {
              const compiled = await vueCompiler.compileStyleAsync({
                source: style.content,
                filename: resourcePath,
                id:hashId,
                scoped: style.scoped,
                preprocessLang: style.lang,
                modules: !!style.module
              });
              if (compiled.errors.length > 0) {
                throw compiled.errors[0];
              }
              codes.push(compiled.code);
            }
            contents = codes.join("\n");
        }

    }else{
        if(descriptor.script){

            contents = '';
            const scriptResult = vueCompiler.compileScript(descriptor, {
                id: hashId,
                inlineTemplate:false,
                sourceMap
            });

            map = scriptResult.content.map;
            contents += vueCompiler.rewriteDefault(scriptResult.content, "__sfc_main");
            if (descriptor.styles.length > 0) {
                contents += `\nimport "${resourcePath}?vue&type=style";`;
            }

            if (descriptor.template) {
                contents += `
                import { render as __render } from "${resourcePath}?vue&type=template";
                const __sfc_main_opts = __sfc_main.__vccOpts || __sfc_main;
                __sfc_main_opts.render = __render;
                `;

                if(relativePath){
                    contents += `
                    __sfc_main_opts.__file = "${relativePath}";
                    `; 
                }

                if (hasScoped) {
                    contents += `
                    __sfc_main_opts.__scopeId = "data-v-${hashId}";
                    `;
                }
            }
            contents += `\nexport default __sfc_main;`;
        }
    }
    return {
        code:contents,
        map
    };
}

function base64Encode(file, content){
    const type = mime.lookup(file);
    return `data:${type};base64,${content}`;
}

{
    createPreprocess();
}

const filter = /\.es(\?|$)/i;
const assetsFilter = /\.(css|less|sass|scss|png|gif|jpeg|jpg|svg|svgz|webp|bmp)$/i

const loader=(compile, plugins=[], options={})=>{
    const hasOwn = Object.prototype.hasOwnProperty;
    const resolvePath = (file, baseDir)=>{
        if(path.isAbsolute(file)){
            return file;
        }
        return path.join(baseDir||compile.workspace, file);
    }

    const newPluginInstance=(config={})=>{
        const load = ()=>{
            if(config.plugin && typeof config.plugin==='function'){
                return config.plugin;
            }else if(config.name){
                return require(config.name)
            }else{
                throw new Error('Plugin name invalid')
            }
        }
        const builder = load();
        return new builder(compile, config.options)
    }

    const getCompilation = (file)=>{
        const {resourcePath} = parseResource(file);
        const absPath = compile.normalizePath(path.isAbsolute(resourcePath) ? resourcePath : path.join(process.cwd(), resourcePath))
        const resourceId = compile.getResourceId(absPath);
        return compile.compilations.get(resourceId);
    }

    const createTypes=async (stat, outdir, compile)=>{
        const outputs = stat.metafile.outputs;
        const datamap = new Map();
        Object.keys(outputs).forEach( dist=>{
            const stas = outputs[dist];
            const entryPoint = stas.entryPoint;
            const entryCompilation = entryPoint ? getCompilation(entryPoint) : null;
            const inputs = stas.inputs;
            const relativePath = './'+path.relative(outdir, dist);
            if(entryCompilation){
                datamap.set(entryCompilation, relativePath);
            }
            Object.keys(inputs).forEach(file=>{
                if(!filter.test(file))return;
                const compi = getCompilation(file)
                if(compi){
                    if(entryCompilation === compi){
                        datamap.set(compi, relativePath);
                    }else if(!datamap.has(compi)){
                        datamap.set(compi, null);
                    }
                }
            });
        });
        await makeTyping(datamap, outdir, compile);
    }

    return {
        name:'easescript',
        async setup(build){

            await compile.initialize();
            const pluginInstances = plugins.map(newPluginInstance);
            const clients = pluginInstances.filter(item=>item.platform ==='client');
            const servers = pluginInstances.filter(item=>item.platform ==='server');
            const compilations = new Set();
            const builder = clients[0];

            if(!builder){
                throw new Error('Builder is not exists.')
            }

            let outdir = options.output;
            if(build.initialOptions.outdir){
                outdir = resolvePath(build.initialOptions.outdir, compile.options.cwd || process.cwd())
            }else if(build.initialOptions.outfile){
                outdir = resolvePath(path.dirname(build.initialOptions.outfile), compile.options.cwd || process.cwd())
            }

            const isProduction = options.mode === 'production' || process.env.NODE_ENV === 'production';
            const isVueTemplate = builder.options.format ==='vue-raw' || builder.options.format ==='vue-template' || builder.options.format ==='vue-jsx';

            let vueCompiler = null
            if(isVueTemplate){
                vueCompiler = tryRequire('@vue/compiler-sfc')
                if(!vueCompiler){
                    throw new Error(`'@vue/compiler-sfc' is not found`)
                }
            }

            if(!builder.options.output){
                builder.options.output = outdir;
            }

            if(servers.length>0){
                compile.addListener('onParseDone',(compilation)=>{
                    servers.forEach( plugin=>{
                        if(compile.isPluginInContext(plugin, compilation)){
                            compilations.add(compilation)
                            plugin.build(compilation);
                        }
                    })
                })
            }

            build.onEnd( async(stat)=>{
                if(stat.errors.length)return;
                const errors = compile.errors.filter(err=>(err.kind === Diagnostic.ERROR));
                if(errors.length>0){
                    console.info(`${Lang.get('note')} ${Lang.get(100, errors.length)}`)
                }
                if(options.emitTypes){
                    await createTypes(stat, outdir, compile);
                }
            });

            build.onResolve({filter}, async args => {
                const file = resolvePath(args.path);
                if(options.excludeGlobalClassBundle){
                    const compi = getCompilation(file);
                    if(compi && compi.isGlobalDocument()){
                        const {query} = parseResource(args.path);
                        let id = query.id;
                        if(!id){
                            id = path.basename(compi.file, path.extname(compi.file));
                        }
                        return {
                            path:'esglobal:'+id,
                            namespace:'file',
                            external:true
                        }
                    }
                }
                return {path:file,namespace:'file'}
            });

            build.onLoad({filter, namespace:'file'}, args=>{
                return new Promise( async(resolve,reject)=>{
                    const {resourcePath,resource,query} = parseResource(args.path);
                    const compilation = await compile.ready(resourcePath);
                    const errors = compilation.errors.filter( error=>error.kind === Diagnostic.ERROR).map(transformError)
                    if(query.callhook != null && query.action){
                        try{
                            const code = await builder.callHook(query.action, compilation, query);
                            resolve({
                                contents:code,
                                loader:'js',
                                errors
                            });
                        }catch(e){
                            reject(e);
                        }
                        return;
                    }

                    if(isVueTemplate && !compilations.has(compilation) ){
                        compilation.on('onClear',()=>{
                            vueRecords.delete(compilation.file);
                        });
                    }

                    compilations.add(compilation);
                    compilation.errors.forEach( error=>{
                        reportDiagnosticMessage(error)
                    });

                    let loader = query.type === 'style' ? 'css' : 'js';

                    builder.build(compilation, async (error)=>{
                        if(error){
                            reject(error);
                        }else{

                            let filepath = compilation.file || compile.normalizePath(resourcePath);
                            let code = null
                            let sourcemap = null;
                            if(!isVueTemplate && query.type === 'style' || query.type === 'embedAssets'){
                                let asset = builder.getBuildAssets(filepath, query.index, query.type);
                                if(asset){
                                    code = String(asset.content);
                                }
                            }else{
                                let buildModule = builder.getBuildModule(filepath, isVueTemplate || query.type ? null : query.id )
                                if(buildModule){
                                    code = String(buildModule.content);
                                    sourcemap = buildModule.sourceMap
                                }
                            }

                            if(query.type === 'embedAssets'){
                                loader = 'text';
                            }

                            if( isVueTemplate && (query.vue && query.type || /^<(template|script|style)>/.test(code)) ){

                                const result = await vueCompile(vueCompiler, filepath, compile.normalizePath(path.relative(compile.workspace, filepath)),  code, query, !!sourcemap);
                                code = result.code;
                                sourcemap = result.map;
                                if(query.type === 'style'){
                                    loader = 'css';
                                }

                            }else if(query && query.type === 'style'){
                                if(isVueTemplate){
                                    const {hashId} = vueRecords.get(filepath);
                                    query.scopeId = hashId;
                                }

                                const lang = query.lang;
                                const preprocess = options.styles?.preprocess;
                                const scoped = !!query.scopeId;
                                const scopeId = scoped ? (builder.options.scopeIdPrefix + query.scopeId) : '';
                                let preprocessor = hasOwn.call(preprocess, lang) ? preprocess[lang] : stylePreprocess[lang];
                                if(!preprocessor && stylePreprocess.transform){
                                    preprocessor = stylePreprocess.transform;
                                }
                                if(preprocessor){
                                    const result = await preprocessor({
                                        source:code,
                                        filename:resourcePath,
                                        resource,
                                        sourcemap,
                                        scoped,
                                        scopeId:scopeId,
                                        lang,
                                        isProd:isProduction
                                    });
                                    if(result){
                                        if(Array.isArray(result.errors)){
                                            errors.push( ...result.errors.map(transformError) );
                                        }
                                        code =result.code;
                                        if(result.map || result.sourcemap){
                                            sourcemap = result.sourcemap || result.map;
                                        }
                                    }
                                }
                            }

                            if( !query.type ){
                                if(sourcemap){
                                    sourcemap = JSON.stringify(sourcemap);
                                    if(options.emitSourcemapFile){
                                        const extname = path.extname(resourcePath);
                                        const name = path.basename(resourcePath, extname);
                                        const key = createHash("sha256").update(`${resource}`).digest("hex").substring(0, 8);
                                        const basedir = path.join(outdir,'.map');
                                        fsExtra.mkdirpSync(basedir);
                                        let mappath = path.join(basedir, `${name}-${key}${extname}.map`);
                                        fs.writeFileSync(mappath,sourcemap);
                                    }
                                    code += '\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(sourcemap).toString('base64');
                                }
                            }
                            
                            resolve({
                                contents:code,
                                loader,
                                errors
                            });
                        }
                    })
                })
            });

            build.onResolve({filter:assetsFilter, namespace:'file'}, async args=>{
                let resolvePath = args.path;
                if(!path.isAbsolute(resolvePath)){
                    resolvePath = path.join(compile.workspace, resolvePath);
                }
                if( fs.existsSync(resolvePath)){
                    return {path:resolvePath,namespace:'file'}
                }
            });

            build.onLoad({filter:assetsFilter, namespace:'file'}, async args=>{
                let resolvePath = args.path;
                if( fs.existsSync(resolvePath) ){
                    let errors = [];
                    let code = fs.readFileSync(resolvePath);
                    let name = path.extname(resolvePath).toLowerCase();
                    let lang = name.slice(1);
                    let loader = options.loaders[name] || 'file';
                    let base64Callback = options.assets.base64Callback;
                    if(base64Callback && base64Callback(resolvePath)===true){
                        code = base64Encode(resolvePath, code.toString('base64'));
                        loader = 'text';
                    }

                    if( /\.(css|less|sass|scss)$/i.test(resolvePath) ){

                        let preprocess = options.styles.preprocess;
                        let preprocessor = hasOwn.call(preprocess, lang) ? preprocess[lang] : stylePreprocess[lang];
                        if(!preprocessor && stylePreprocess.transform){
                            preprocessor = stylePreprocess.transform;
                        }

                        if(preprocessor){
                            const result = await preprocessor({
                                source:code,
                                filename:resolvePath,
                                resource:resolvePath,
                                lang:lang,
                                isProd:isProduction
                            });
                            if(result){
                                if(Array.isArray(result.errors)){
                                    errors.push( ...result.errors.map(transformError) );
                                }
                                code =result.code;
                            }
                        }else{
                            if(lang==='scss'||lang==='sass'){
                                return await scssCompile(resolvePath, code, options.emitSourcemapFile);
                            }else if(lang==='less'){
                                return await lessCompile(resolvePath, code, options.emitSourcemapFile);
                            }
                        }
                    }

                    return {
                        contents:code,
                        loader:loader,
                        errors
                    }
                }
            });

            Object.keys(options.resolve.alias).forEach( key=>{
                const filter = new RegExp(key);
                const replacePath = options.resolve.alias[key];
                build.onResolve({filter, namespace:'file'}, async args=>{
                    if(args.kind!=='import-statement')return;
                    let resolvePath = args.path;
                    let path2 = resolvePath.replace(filter, (prefix)=>{
                        return path.join(replacePath,prefix);
                    });
                    let result = await build.resolve(path2, {kind:args.kind,resolveDir:path.dirname(path2)});
                    if(result && !result.errors.length){
                        return result;
                    }
                })
            });

        }
    }
}

module.exports = loader;