
const esbuild = require('esbuild');
const loader = require('./loader');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const Compiler = require('easescript/lib/core/Compiler');
function formatMessage(outdir){
    let message = [
        'Build successful!',
        `Output:${outdir}`
    ];

    let strLen = 0;
    let hideMaxLen = 0;
    let hideChars = ['\x1B[31m','\x1B[39m'];
    message.forEach( item=>{
        let len = 0;
        hideChars.forEach( match=>{
            if( item.includes(match) ){
                len+=match.length;
            }
        });
        if(len>0){
            hideMaxLen = Math.max(len, hideMaxLen);
        }
        strLen = Math.max(strLen, item.length);
    });

    let sep =  '*'.repeat(strLen-hideMaxLen+10);
    let format = ()=>{
        let padding = '   ';
        return message.map( item=>{
            item = item.padEnd(strLen-(padding.length*2)-4);
            item = padding+item+padding;
            item = sep.slice(0,2) +item + sep.slice(-2);
            return item;
        }).join('\n');
    }
    console.info(chalk.green(`${sep}\n${format()}\n${sep}`))
}

function hasClientPlugin(plugins){
    return plugins.some( plugin=>{
        return ['es-vue','es-javascript','es-nuxt','es-uniapp'].includes( plugin.name );
    });
}

async function builder(compile, escOptions, files){
    const plugins = compile.options.plugins
    let outdir = escOptions.output;
    if(outdir && !path.isAbsolute(outdir)){
        outdir = path.join(compile.options.cwd, outdir);
    }

    await compile.initialize();

    const pluginInstances = plugins.map(config=>{
        const plugin = config.plugin;
        const options = config.options;
        if(outdir)options.output = outdir;
        if( typeof plugin ==='function' ){
            return new plugin(compile,options);
        }
    });

    const compilations= new Set();
    await Promise.allSettled(files.map(async file=>{
        const compilation = await compile.createCompilation(file);
        if(compilation){
            compilation.createStack();
            compilations.add(compilation)
        }else{
            console.error(`Not resolved compilation. file:'${file}'`)
        }
    }));
    await Promise.allSettled(Array.from(compilations).map(compilation=>compilation.createCompleted()));
    await Promise.allSettled(Array.from(compilations).map((compilation)=>{
        return new Promise( async(resolve)=>{
            await compilation.ready();
            await Promise.allSettled(pluginInstances.map((plugin)=>{
                return new Promise((resolve)=>{
                    plugin.build(compilation, (error)=>{
                        if(error)console.error(error);
                        resolve();
                    });
                })
            }));
            resolve();
        })
    }));
}

async function bundle(compile, escOptions, files){
    const plugins = escOptions.plugins || [];
    let output = escOptions.output;
    plugins.unshift( loader(compile, escOptions) );
    if(!output){
        output = 'build';
        const clients = ['es-vue','es-javascript','es-nuxt','es-uniapp']
        const client = plugins.find(plugin=>clients.includes(plugin.name))
        if(client && client.options.output){
            output = client.options.output;
        }
    }
    
    const splitting = escOptions.splitting === false ? false : (escOptions.splitting ? true : files.length>1)
    const esbuildOptions = {
        entryPoints:files,
        entryNames:escOptions.entryNames || '[name]',
        chunkNames:escOptions.chunkNames || 'deps/[hash]',
        splitting:splitting,
        bundle: escOptions.bundle,
        outdir: output,
        format: escOptions.format || 'esm',
        platform: escOptions.platform || 'node',
        metafile:true,
        loader:escOptions.loaders,
        treeShaking:escOptions.treeShaking,
        nodePaths:escOptions.resolve.paths,
        minify:escOptions.minify,
        sourcemap:!!escOptions.sourcemap,
        resolveExtensions:escOptions.resolve.extensions,
        define:escOptions.define,
        external:escOptions.externals || [],
        plugins,
    };

    if(escOptions.watch){
        esbuild.context(esbuildOptions).then( async ctx=>{
            await ctx.watch();
            console.info('[ESC] Starting compilation in watch mode...')
        }).catch(e=>{
            console.error( e )
        });
    }else{
        esbuild.build(esbuildOptions).then( res=>{
            if(res.errors.length>0){
                console.info(`Build done. but found ${res.errors.length} errors`)
            }else{
                console.info('\n[ESC] Build done.\n')
            }
        }).catch(e=>{
            console.error(e)
        });
    }
}

module.exports = async(options)=>{
    let files = options.file;
    const compilerOptions = {
        diagnose:true,
        enableComments:true,
        lang:'zh-CN',
        configFileName:null,
        suffix:null,
        workspace:null,
        reserved:null,
        throwError:null,
        types:null,
    }

    Object.keys(compilerOptions).forEach(key=>{
        if( options[key] ){
            compilerOptions[key] = options[key];
        }else if(compilerOptions[key]===null){
            delete compilerOptions[key];
        }
    });

    let escOptions = {};
    escOptions.define = {
        'process.env.NODE_ENV':`"${options.mode}"`
    };

    compilerOptions.esc = escOptions;
    Object.keys(options).forEach( key=>{
        if(!Object.prototype.hasOwnProperty.call(compilerOptions, key)){
            escOptions[key] = options[key];
        }
    });

    const compile = new Compiler(compilerOptions);
    escOptions = compile.options.esc;
    if(!compile.options.plugins.length){
        throw new ReferenceError('Not found plugins.')
    }

    if(!files && compile.options.input){
        files = compile.options.input;
    }

    if(files && !Array.isArray(files)){
        files = [files];
    }
    
    if(files){
        files = files.map( file=>{
            if(!path.isAbsolute(file)){
                file = path.join(compile.workspace, file)
            }
            if(!fs.existsSync(file))return [];
            if(fs.statSync(file).isDirectory()){
                const dir = file;
                const files = [];
                fs.readdirSync(dir).forEach( file=>{
                    if(file==='.' || file==='..')return false;
                    file = path.join(dir,file);
                    if(fs.statSync(file).isFile() && file.endsWith(compile.options.suffix)){
                        files.push(file);
                    }
                });
                return files;
            }else if(file.endsWith(compile.options.suffix)){
                return [file];
            }
            return []
        }).flat();
    }else{
        const tries = ['App.es','Index.es','app.es','index.es'].map( name=> path.join(compile.workspace, name) )
        const result = tries.find(file=>fs.existsSync(file))
        if(result){
            files =[result];
        }else{
            throw new ReferenceError('Not found entry file.')
        }
    }

    if(!files.length){
        throw new ReferenceError('Not found entry files')
    }

    if(!hasClientPlugin(compile.options.plugins)){
        builder(compile, escOptions, files);
    }else{
        bundle(compile, escOptions, files);
    } 
}